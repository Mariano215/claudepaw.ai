import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `claudepaw-telemetry-test-${process.pid}`)

vi.mock('./config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const dir = path.join(os.tmpdir(), `claudepaw-telemetry-test-${process.pid}`)
  return { STORE_DIR: dir }
})

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { initTelemetryDatabase, getTelemetryDb } from './telemetry-db.js'
import { RequestTracker } from './telemetry.js'

describe('RequestTracker', () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    initTelemetryDatabase()
  })

  beforeEach(() => {
    const db = getTelemetryDb()
    db.prepare('DELETE FROM tool_calls').run()
    db.prepare('DELETE FROM agent_events').run()
  })

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('normalizes synthetic API runtime events and persists execution metadata', () => {
    const tracker = new RequestTracker('chat-1', 'api', 'runtime test')
    tracker.setAgentId('builder')

    tracker.recordSdkEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'openai-api-123',
      sessionId: 'openai-api-123',
      model: 'gpt-5.4',
    })
    tracker.recordSdkEvent({
      type: 'result',
      result: 'done',
      subtype: 'success',
      total_cost_usd: null,
      duration_ms: 321,
      duration_api_ms: 320,
      is_error: false,
      num_turns: 1,
      usage: {
        input_tokens: 12,
        output_tokens: 4,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      },
      modelUsage: null,
      session_id: 'openai-api-123',
    })
    tracker.setExecutionMeta({
      requestedProvider: 'openai_api',
      executedProvider: 'openai_api',
      providerFallbackApplied: false,
    })
    tracker.finalize()

    const row = getTelemetryDb()
      .prepare(`
        SELECT session_id, model, input_tokens, output_tokens,
               requested_provider, executed_provider, provider_fallback_applied,
               duration_ms, duration_api_ms, is_error, agent_id, result_summary
        FROM agent_events
        WHERE chat_id = ?
      `)
      .get('chat-1') as Record<string, any>

    expect(row.session_id).toBe('openai-api-123')
    expect(row.model).toBe('gpt-5.4')
    expect(row.input_tokens).toBe(12)
    expect(row.output_tokens).toBe(4)
    expect(row.requested_provider).toBe('openai_api')
    expect(row.executed_provider).toBe('openai_api')
    expect(row.provider_fallback_applied).toBe(0)
    expect(row.duration_ms).toBe(321)
    expect(row.duration_api_ms).toBe(320)
    expect(row.is_error).toBe(0)
    expect(row.agent_id).toBe('builder')
    expect(row.result_summary).toBe('done')
  })

  it('stores fallback execution metadata on error-shaped synthetic events', () => {
    const tracker = new RequestTracker('chat-2', 'api', 'runtime fallback test')

    tracker.recordSdkEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
      model: 'claude-sonnet-4-6',
    })
    tracker.recordSdkEvent({
      type: 'result',
      result: null,
      subtype: 'error_during_execution',
      total_cost_usd: null,
      duration_ms: 999,
      duration_api_ms: 999,
      is_error: true,
      num_turns: 1,
      usage: null,
      modelUsage: { retries: 1 },
      session_id: 'claude-session-1',
    })
    tracker.setExecutionMeta({
      requestedProvider: 'codex_local',
      executedProvider: 'claude_desktop',
      providerFallbackApplied: true,
    })
    tracker.finalize()

    const row = getTelemetryDb()
      .prepare(`
        SELECT requested_provider, executed_provider, provider_fallback_applied,
               is_error, session_id, model_usage_json
        FROM agent_events
        WHERE chat_id = ?
      `)
      .get('chat-2') as Record<string, any>

    expect(row.requested_provider).toBe('codex_local')
    expect(row.executed_provider).toBe('claude_desktop')
    expect(row.provider_fallback_applied).toBe(1)
    expect(row.is_error).toBe(1)
    expect(row.session_id).toBe('claude-session-1')
    expect(row.model_usage_json).toBe(JSON.stringify({ retries: 1 }))
  })
})
