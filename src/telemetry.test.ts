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
import { RequestTracker, summarizeToolInput } from './telemetry.js'

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

  it('matches a tool_result block to the prior tool_use and stamps duration + success=1', async () => {
    const tracker = new RequestTracker('chat-tr', 'api', 'tool result match', 'proj-1')

    tracker.recordSdkEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_01BBB', name: 'Read', input: { file_path: '/tmp/x.txt' } },
        ],
      },
    })

    // Simulate the 2ms gap between tool_use and tool_result so duration is > 0
    await new Promise((r) => setTimeout(r, 5))

    tracker.recordSdkEvent({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01BBB', content: 'file contents', is_error: false },
        ],
      },
    })
    tracker.finalize()

    const row = getTelemetryDb()
      .prepare(`SELECT duration_ms, success, error FROM tool_calls WHERE tool_use_id = ?`)
      .get('toolu_01BBB') as Record<string, any>

    expect(row.success).toBe(1)
    expect(row.error).toBeNull()
    expect(typeof row.duration_ms).toBe('number')
    expect(row.duration_ms).toBeGreaterThan(0)
    expect(row.duration_ms).toBeLessThan(10_000)
  })

  it('redacts secrets inside a string-typed tool_result error body', () => {
    const tracker = new RequestTracker('chat-errsec', 'api', 'error redact', 'proj-1')

    tracker.recordSdkEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_01ERR', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer x" api.example.com' } },
        ],
      },
    })
    tracker.recordSdkEvent({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01ERR',
            // Error body echoes back the Authorization header unredacted
            content: 'curl failed: Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
            is_error: true,
          },
        ],
      },
    })
    tracker.finalize()

    const row = getTelemetryDb()
      .prepare(`SELECT error FROM tool_calls WHERE tool_use_id = ?`)
      .get('toolu_01ERR') as Record<string, any>

    expect(row.error).toBeTruthy()
    expect(row.error).toContain('[REDACTED]')
    expect(row.error).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
  })

  it('marks a tool call failed when tool_result has is_error=true and captures the error snippet', () => {
    const tracker = new RequestTracker('chat-err', 'api', 'tool error capture', 'proj-1')

    tracker.recordSdkEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_01CCC', name: 'Bash', input: { command: 'false' } },
        ],
      },
    })
    tracker.recordSdkEvent({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_01CCC', content: 'Command failed: exit 1', is_error: true },
        ],
      },
    })
    tracker.finalize()

    const row = getTelemetryDb()
      .prepare(`SELECT success, error FROM tool_calls WHERE tool_use_id = ?`)
      .get('toolu_01CCC') as Record<string, any>

    expect(row.success).toBe(0)
    expect(row.error).toBe('Command failed: exit 1')
  })

  it('redacts known secret patterns in tool_input_summary before persisting', () => {
    expect(summarizeToolInput({ headers: 'Authorization: Bearer ghp_abcd1234567890abcd1234567890abcd12' }))
      .toContain('[REDACTED]')
    expect(summarizeToolInput({ env: 'OPENAI_API_KEY=sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGG' }))
      .toContain('[REDACTED]')
    expect(summarizeToolInput({ token: 'xoxb-12345-abcdef-abcdefghijklmn' }))
      .toContain('[REDACTED]')
    expect(summarizeToolInput({ api_key: 'sk-ant-api03-supersecrettokenvalue123456' }))
      .toContain('[REDACTED]')
    // Benign input passes through
    expect(summarizeToolInput({ command: 'echo hello' }))
      .not.toContain('[REDACTED]')
  })

  it('redacts passwords embedded in database connection string URLs', () => {
    expect(summarizeToolInput({ env: 'DATABASE_URL=postgres://admin:SuperSecret123@db.example.com/prod' }))
      .toContain('[REDACTED]')
    expect(summarizeToolInput({ env: 'DATABASE_URL=postgres://admin:SuperSecret123@db.example.com/prod' }))
      .not.toContain('SuperSecret123')
    expect(summarizeToolInput('mysql://root:MyRootPwd7!@host:3306/app'))
      .toContain('[REDACTED]')
    expect(summarizeToolInput('mysql://root:MyRootPwd7!@host:3306/app'))
      .not.toContain('MyRootPwd7!')
    expect(summarizeToolInput('mongodb://user:ZxCvBnM9@cluster/db'))
      .toContain('[REDACTED]')
    // No password in the URL -- nothing to redact
    expect(summarizeToolInput('postgres://localhost:5432/dev'))
      .not.toContain('[REDACTED]')
  })

  it('redacts AWS SecretAccessKey when adjacent to the keyword', () => {
    expect(summarizeToolInput('aws_secret_access_key=abcdEFghIJklMN0123456789abcdefghijKL+'))
      .toContain('[REDACTED]')
    expect(summarizeToolInput('AWS_SECRET_ACCESS_KEY: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toContain('[REDACTED]')
  })

  it('extracts text from a tool_result error body structured as an array of content blocks', () => {
    const tracker = new RequestTracker('chat-blocks', 'api', 'content blocks error', 'proj-1')
    tracker.recordSdkEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_blocks', name: 'WebFetch', input: { url: 'https://example.com' } },
        ],
      },
    })
    tracker.recordSdkEvent({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_blocks',
            content: [
              { type: 'text', text: 'Fetch failed: 403 Forbidden. token=hf_abcdefghijklmnopqrstuvwxyz0123456789' },
            ],
            is_error: true,
          },
        ],
      },
    })
    tracker.finalize()
    const row = getTelemetryDb()
      .prepare(`SELECT error FROM tool_calls WHERE tool_use_id = ?`)
      .get('toolu_blocks') as Record<string, any>
    expect(row.error).toContain('Fetch failed')
    expect(row.error).toContain('[REDACTED]')
    // Raw JSON wrapper should not be persisted -- we extract text first
    expect(row.error).not.toContain('"type":"text"')
  })

  it('redacts HuggingFace tokens, Telegram bot tokens, and PEM private key headers', () => {
    // HuggingFace
    expect(summarizeToolInput('headers: Authorization: Bearer hf_abcdefghijklmnopqrstuvwxyz0123456789'))
      .toContain('[REDACTED]')
    expect(summarizeToolInput('hf_abcdefghijklmnopqrstuvwxyz0123456789AB'))
      .toContain('[REDACTED]')
    // Telegram bot token: <bot_id>:<exactly 35 char hash>
    expect(summarizeToolInput({ curl: 'https://api.telegram.org/bot1234567890:ABCDefGhIJKlmNoPQrsTUvwxy1234567_89/sendMessage' }))
      .toContain('[REDACTED]')
    // PEM private key header
    expect(summarizeToolInput('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAA...\n-----END RSA PRIVATE KEY-----'))
      .toContain('[REDACTED]')
    expect(summarizeToolInput('-----BEGIN PRIVATE KEY-----\nMIIEvQI...\n-----END PRIVATE KEY-----'))
      .toContain('[REDACTED]')
  })

  it('truncates very long tool inputs to 200 chars with an ellipsis', () => {
    const longInput = { command: 'echo ' + 'A'.repeat(500) }
    const summary = summarizeToolInput(longInput)
    expect(summary.length).toBeLessThanOrEqual(200)
    expect(summary.endsWith('…')).toBe(true)
  })

  it('returns [unserializable] when tool input cannot be stringified', () => {
    const circular: any = { a: 1 }
    circular.self = circular
    expect(summarizeToolInput(circular)).toBe('[unserializable]')
  })

  it('returns empty string (not a crash) when tool input is undefined', () => {
    // JSON.stringify(undefined) returns undefined, not a string. Must not throw.
    expect(() => summarizeToolInput(undefined)).not.toThrow()
    expect(summarizeToolInput(undefined)).toBe('')
  })

  it('ignores orphan tool_result blocks without a matching tool_use', () => {
    const tracker = new RequestTracker('chat-orphan', 'api', 'orphan tool_result', 'proj-1')

    // tool_result with no prior tool_use -- must NOT crash and must NOT insert a row
    tracker.recordSdkEvent({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_nobody', content: 'ok', is_error: false },
        ],
      },
    })
    tracker.finalize()

    const count = getTelemetryDb()
      .prepare(`SELECT COUNT(*) as c FROM tool_calls WHERE event_id = ?`)
      .get(tracker.eventId) as { c: number }
    expect(count.c).toBe(0)
  })

  it('captures a tool_use block inside an assistant event', () => {
    const tracker = new RequestTracker('chat-tu', 'api', 'tool use capture', 'proj-1')

    tracker.recordSdkEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Running it' },
          { type: 'tool_use', id: 'toolu_01AAA', name: 'Bash', input: { command: 'echo hi' } },
        ],
      },
    })
    tracker.finalize()

    const row = getTelemetryDb()
      .prepare(`
        SELECT event_id, tool_use_id, tool_name, tool_input_summary,
               started_at, duration_ms, success, error
        FROM tool_calls
        WHERE event_id = ?
      `)
      .get(tracker.eventId) as Record<string, any>

    expect(row).toBeDefined()
    expect(row.tool_use_id).toBe('toolu_01AAA')
    expect(row.tool_name).toBe('Bash')
    expect(row.tool_input_summary).toContain('echo hi')
    expect(typeof row.started_at).toBe('number')
    expect(row.started_at).toBeGreaterThan(0)
    // Unmatched tool_use has no duration/success yet -- should be NULL
    expect(row.duration_ms).toBeNull()
    expect(row.success).toBeNull()
    expect(row.error).toBeNull()
  })
})
