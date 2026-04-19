import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock logger before any imports
vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Mock guard chain
vi.mock('./guard/index.js', () => ({
  guardChain: {
    hardenPrompt: vi.fn(() => ({ systemPrompt: '', canary: undefined, delimiterID: undefined })),
  },
}))

// Mock action items
vi.mock('./action-items.js', () => ({
  parseActionItemsFromAgentOutput: vi.fn(() => []),
  ingestParsedItems: vi.fn(() => []),
}))

// Mock config
vi.mock('./config.js', () => ({
  TYPING_REFRESH_MS: 3000,
}))

// Mock kill-switch-client --will be controlled per-test via spyOn after import
vi.mock('./cost/kill-switch-client.js', () => ({
  checkKillSwitch: vi.fn(async () => null),
}))

// Mock cost-gate --will be controlled per-test via spyOn after import
vi.mock('./cost/cost-gate.js', () => ({
  getCostGateStatus: vi.fn(async () => ({
    action: 'allow',
    percent_of_cap: 0,
    mtd_usd: 0,
    today_usd: 0,
    monthly_cap_usd: null,
    daily_cap_usd: null,
    triggering_cap: null,
  })),
}))

// Mock agent-runtime --spy on the namespace object so vi.spyOn works
import * as runtime from './agent-runtime.js'

vi.mock('./agent-runtime.js', () => ({
  runAgentWithResolvedExecution: vi.fn(async () => ({
    settings: { provider: 'claude_desktop' },
    result: {
      text: 'agent ok',
      newSessionId: undefined,
      resultSubtype: 'success',
      executedProvider: 'claude_desktop',
      providerFallbackApplied: false,
      eventCount: 1,
      assistantTurns: 1,
      toolUses: 0,
      lastEventType: 'result',
    },
  })),
}))

import * as killSwitchMod from './cost/kill-switch-client.js'
import * as costGateMod from './cost/cost-gate.js'
import { runAgent } from './agent.js'

describe('runAgent gate enforcement', () => {
  beforeEach(() => {
    vi.resetAllMocks()

    // Reset runtime spy to succeed by default
    vi.mocked(runtime.runAgentWithResolvedExecution).mockResolvedValue({
      settings: { provider: 'claude_desktop' } as any,
      result: {
        text: 'agent ok',
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

    // Default: kill switch off
    vi.mocked(killSwitchMod.checkKillSwitch).mockResolvedValue(null)

    // Default: cost gate allows
    vi.mocked(costGateMod.getCostGateStatus).mockResolvedValue({
      action: 'allow',
      percent_of_cap: 0,
      mtd_usd: 0,
      today_usd: 0,
      monthly_cap_usd: null,
      daily_cap_usd: null,
      triggering_cap: null,
    })
  })

  it('kill switch active: returns refusal without calling runtime', async () => {
    vi.mocked(killSwitchMod.checkKillSwitch).mockResolvedValue({
      reason: 'maintenance',
      set_at: Date.now(),
    })

    const result = await runAgent(
      'do something',
      undefined,
      undefined,
      false,
      undefined,
      { projectId: 'test-project', source: 'test' },
    )

    expect(result.text).toMatch(/system is paused/i)
    expect(result.emptyReason).toMatch(/kill.*switch/i)
    expect(runtime.runAgentWithResolvedExecution).not.toHaveBeenCalled()
  })

  it('cost gate refuse: returns refusal with cap info without calling runtime', async () => {
    vi.mocked(killSwitchMod.checkKillSwitch).mockResolvedValue(null)
    vi.mocked(costGateMod.getCostGateStatus).mockResolvedValue({
      action: 'refuse',
      percent_of_cap: 92.5,
      mtd_usd: 18.5,
      today_usd: 2.1,
      monthly_cap_usd: 20,
      daily_cap_usd: null,
      triggering_cap: 'monthly',
    })

    const result = await runAgent(
      'do something',
      undefined,
      undefined,
      false,
      undefined,
      { projectId: 'test-project', source: 'test' },
    )

    expect(result.text).toContain('$20')
    expect(result.text).toMatch(/raise cap in settings/i)
    expect(result.emptyReason).toMatch(/cost cap exceeded at 93%/)
    expect(runtime.runAgentWithResolvedExecution).not.toHaveBeenCalled()
  })

  it('cost gate override_to_ollama: runtime called with provider ollama', async () => {
    vi.mocked(killSwitchMod.checkKillSwitch).mockResolvedValue(null)
    vi.mocked(costGateMod.getCostGateStatus).mockResolvedValue({
      action: 'override_to_ollama',
      percent_of_cap: 75,
      mtd_usd: 15,
      today_usd: 1.5,
      monthly_cap_usd: 20,
      daily_cap_usd: null,
      triggering_cap: 'monthly',
    })

    await runAgent(
      'do something',
      undefined,
      undefined,
      false,
      undefined,
      { projectId: 'test-project', source: 'test' },
    )

    expect(runtime.runAgentWithResolvedExecution).toHaveBeenCalledOnce()
    const callArgs = vi.mocked(runtime.runAgentWithResolvedExecution).mock.calls[0]
    const runtimeCtx = callArgs[1] as any
    expect(runtimeCtx?.executionOverride?.provider).toBe('ollama')
  })

  it('cost gate allow: runtime called with no override', async () => {
    vi.mocked(killSwitchMod.checkKillSwitch).mockResolvedValue(null)
    vi.mocked(costGateMod.getCostGateStatus).mockResolvedValue({
      action: 'allow',
      percent_of_cap: 20,
      mtd_usd: 4,
      today_usd: 0.5,
      monthly_cap_usd: 20,
      daily_cap_usd: null,
      triggering_cap: null,
    })

    await runAgent(
      'do something',
      undefined,
      undefined,
      false,
      undefined,
      { projectId: 'test-project', source: 'test' },
    )

    expect(runtime.runAgentWithResolvedExecution).toHaveBeenCalledOnce()
    const callArgs = vi.mocked(runtime.runAgentWithResolvedExecution).mock.calls[0]
    const runtimeCtx = callArgs[1] as any
    expect(runtimeCtx?.executionOverride?.provider).toBeUndefined()
  })
})
