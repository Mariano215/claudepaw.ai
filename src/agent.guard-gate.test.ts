import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('./guard/index.js', () => ({
  guardChain: {
    hardenPrompt: vi.fn(() => ({ systemPrompt: '', userMessage: '', canary: 'CANARY-test', delimiterID: 'delim-test' })),
    postProcess: vi.fn(),
  },
}))

vi.mock('./action-items.js', () => ({
  parseActionItemsFromAgentOutput: vi.fn(() => []),
  ingestParsedItems: vi.fn(() => []),
}))

vi.mock('./config.js', () => ({
  TYPING_REFRESH_MS: 3000,
}))

vi.mock('./cost/kill-switch-client.js', () => ({
  checkKillSwitch: vi.fn(async () => null),
}))

vi.mock('./cost/cost-gate.js', () => ({
  getCostGateStatus: vi.fn(async () => ({
    action: 'allow', percent_of_cap: 0, mtd_usd: 0, today_usd: 0, monthly_cap_usd: null, daily_cap_usd: null, triggering_cap: null,
  })),
  getPoolGateStatus: vi.fn(async () => ({
    action: 'allow', spend_usd: 0, cap_usd: 200, percent_of_pool: 0, override_threshold_pct: 80, hardstop_threshold_pct: 95, projected_eom_usd: 0,
  })),
}))

const { recordErrorMock } = vi.hoisted(() => ({ recordErrorMock: vi.fn() }))
vi.mock('./telemetry.js', () => ({ recordError: recordErrorMock }))

import * as runtime from './agent-runtime.js'
vi.mock('./agent-runtime.js', () => ({
  runAgentWithResolvedExecution: vi.fn(),
}))

import { guardChain } from './guard/index.js'
import { runAgent } from './agent.js'

describe('runAgent guard output gate', () => {
  beforeEach(() => {
    vi.mocked(guardChain.hardenPrompt).mockReturnValue({ systemPrompt: '', userMessage: '', canary: 'CANARY-test', delimiterID: 'delim-test' })
    recordErrorMock.mockClear()

    vi.mocked(runtime.runAgentWithResolvedExecution).mockResolvedValue({
      settings: { provider: 'claude_desktop' } as any,
      result: {
        text: 'a perfectly fine reply',
        newSessionId: undefined,
        resultSubtype: 'success',
        executedProvider: 'claude_desktop',
        providerFallbackApplied: false,
        eventCount: 1,
        assistantTurns: 1,
        toolUses: 0,
        lastEventType: 'result',
      } as any,
    })
  })

  it('passes through a clean result', async () => {
    vi.mocked(guardChain.postProcess).mockResolvedValue({
      response: 'a perfectly fine reply', blocked: false, flagged: false, triggeredLayers: [], blockReason: null, layerResults: [], latencyMs: 1, requestId: 'r1',
    })

    const result = await runAgent('hi')

    expect(result.blocked).toBe(false)
    expect(result.text).toBe('a perfectly fine reply')
  })

  it('nulls the text and marks blocked when the guard blocks the result', async () => {
    vi.mocked(guardChain.postProcess).mockResolvedValue({
      response: 'fallback', blocked: true, flagged: false, triggeredLayers: ['l6-output-validate'], blockReason: 'Canary token leaked in response (system prompt exfiltration)', layerResults: [], latencyMs: 1, requestId: 'r1',
    })

    const result = await runAgent('hi')

    expect(result.blocked).toBe(true)
    expect(result.text).toBeNull()
    expect(result.blockReason).toBe('Canary token leaked in response (system prompt exfiltration)')
    expect(result.blockedLayers).toEqual(['l6-output-validate'])
    expect(recordErrorMock).toHaveBeenCalledWith('guard', 'error', expect.any(String), undefined, expect.any(Object))
  })

  it('fails closed and records an error when postProcess throws for a non-network reason', async () => {
    vi.mocked(guardChain.postProcess).mockRejectedValue(new Error('unexpected bug in validateOutput'))

    const result = await runAgent('hi')

    expect(result.blocked).toBe(true)
    expect(result.text).toBeNull()
    expect(recordErrorMock).toHaveBeenCalledWith('guard', 'error', expect.any(String), expect.any(String), expect.any(Object))
  })

  it('passes through when postProcess throws a sidecar network error', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8099'), { code: 'ECONNREFUSED' })
    vi.mocked(guardChain.postProcess).mockRejectedValue(err)

    const result = await runAgent('hi')

    expect(result.blocked).toBe(false)
    expect(result.text).toBe('a perfectly fine reply')
    expect(recordErrorMock).not.toHaveBeenCalled()
  })
})
