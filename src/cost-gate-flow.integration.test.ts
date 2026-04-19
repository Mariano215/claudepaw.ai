/**
 * cost-gate-flow.integration.test.ts
 *
 * Integration tests for the cost-gate + kill-switch flow through runAgent.
 *
 * Approach: "simpler alternative" from the T3-C plan spec.
 *   - Stubs global fetch so the bot-side clients (kill-switch-client,
 *     cost-gate) receive realistic server payloads without standing up a
 *     real Express server.
 *   - Mocks runAgentWithResolvedExecution so no real Claude session fires.
 *   - Clears both bot-client caches in beforeEach.
 *   - Exercises the FULL dynamic-import path inside runAgent (Tasks 6-8),
 *     not just the unit-tested clients in isolation.
 *
 * Two tests:
 *   A) Kill switch tripped via fetch stub -> runAgent returns "system is paused"
 *   B) Cost cap hit via fetch stub -> runAgent returns "cost cap" refusal
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock heavy dependencies that runAgent pulls in transitively
// ---------------------------------------------------------------------------

vi.mock('./config.js', () => ({
  TYPING_REFRESH_MS: 4000,
  BOT_TOKEN: '',
  ALLOWED_CHAT_ID: '',
  MAX_MESSAGE_LENGTH: 4096,
  STORE_DIR: '/tmp/claudepaw-cost-gate-integration-test',
  PROJECT_ROOT: '/tmp/claudepaw-cost-gate-integration-test',
  CLAUDE_CWD: '/tmp',
  DASHBOARD_URL: 'http://127.0.0.1:4999',
  BOT_API_TOKEN: 'admin-token',
}))

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('./guard/index.js', () => ({
  guardChain: {
    hardenPrompt: vi.fn((_sys: string, msg: string) => ({
      systemPrompt: '',
      message: msg,
      canary: 'test-canary',
      delimiterID: 'test-delimiter',
    })),
  },
}))

vi.mock('./action-items.js', () => ({
  parseActionItemsFromAgentOutput: vi.fn(() => []),
  ingestParsedItems: vi.fn(() => []),
}))

// runAgentWithResolvedExecution is the heavy Claude SDK path -- mock it so
// the test never tries to spawn a real Claude session.
vi.mock('./agent-runtime.js', () => ({
  runAgentWithResolvedExecution: vi.fn(async () => ({
    settings: { provider: 'anthropic_api' },
    result: {
      text: 'hello from mock agent',
      newSessionId: 'mock-session',
      resultSubtype: 'success',
      executedProvider: 'anthropic_api',
      providerFallbackApplied: false,
      eventCount: 1,
      assistantTurns: 1,
      toolUses: 0,
      lastEventType: 'result',
    },
  })),
}))

// ---------------------------------------------------------------------------
// Import test subjects AFTER mocks are registered
// ---------------------------------------------------------------------------

import { runAgent } from './agent.js'
import {
  _resetCache as resetKillSwitchCache,
} from './cost/kill-switch-client.js'
import {
  _resetCache as resetCostGateCache,
} from './cost/cost-gate.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetCaches() {
  resetKillSwitchCache()
  resetCostGateCache()
}

const ACTION_PLAN = { projectId: 'default', source: 'test' }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cost-gate flow integration', () => {
  beforeEach(() => {
    resetCaches()
    vi.restoreAllMocks()
    // Default env so clients know where to point
    process.env.DASHBOARD_BASE_URL = 'http://127.0.0.1:4999'
    process.env.BOT_API_TOKEN = 'admin-token'
  })

  it('Test A: kill switch tripped -- runAgent refuses with "system is paused"', async () => {
    // Stub fetch: kill-switch endpoint returns active=true; cost-gate returns allow
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/v1/system-state/kill-switch')) {
        return {
          ok: true,
          json: async () => ({ active: true, reason: 'spike in billing', set_at: Date.now() }),
        }
      }
      if (u.includes('/api/v1/cost-gate/')) {
        return {
          ok: true,
          json: async () => ({
            action: 'allow',
            percent_of_cap: 0,
            mtd_usd: 0,
            today_usd: 0,
            monthly_cap_usd: null,
            daily_cap_usd: null,
            triggering_cap: null,
          }),
        }
      }
      throw new Error(`Unexpected fetch: ${u}`)
    }))

    const result = await runAgent('hi', undefined, undefined, true, undefined, ACTION_PLAN)

    expect(result.text).toMatch(/system is paused/i)
    expect(result.resultSubtype).toBe('refused')
  })

  it('Test B: monthly cost cap exceeded -- runAgent refuses with "cost cap"', async () => {
    // Stub fetch: kill-switch returns inactive; cost-gate returns refuse (cap hit)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/v1/system-state/kill-switch')) {
        return {
          ok: true,
          json: async () => ({ active: false }),
        }
      }
      if (u.includes('/api/v1/cost-gate/')) {
        return {
          ok: true,
          json: async () => ({
            action: 'refuse',
            percent_of_cap: 112,
            mtd_usd: 0.02,
            today_usd: 0.005,
            monthly_cap_usd: 0.01,
            daily_cap_usd: null,
            triggering_cap: 'monthly',
          }),
        }
      }
      throw new Error(`Unexpected fetch: ${u}`)
    }))

    const result = await runAgent('hi', undefined, undefined, true, undefined, ACTION_PLAN)

    expect(result.text).toMatch(/cost cap/i)
    expect(result.resultSubtype).toBe('refused')
  })
})
