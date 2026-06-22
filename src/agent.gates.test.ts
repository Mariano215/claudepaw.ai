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
  getPoolGateStatus: vi.fn(async () => ({
    action: 'allow',
    spend_usd: 0,
    cap_usd: 200,
    percent_of_pool: 0,
    override_threshold_pct: 80,
    hardstop_threshold_pct: 95,
    projected_eom_usd: 0,
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

    // Default: pool gate allows
    vi.mocked(costGateMod.getPoolGateStatus).mockResolvedValue({
      action: 'allow',
      spend_usd: 0,
      cap_usd: 200,
      percent_of_pool: 0,
      override_threshold_pct: 80,
      hardstop_threshold_pct: 95,
      projected_eom_usd: 0,
    })
  })

  // --- Pool gate (account-wide Anthropic Agent SDK Credit Pool) ---

  it('pool gate refuse: returns refusal without calling runtime', async () => {
    vi.mocked(costGateMod.getPoolGateStatus).mockResolvedValue({
      action: 'refuse',
      spend_usd: 191.42,
      cap_usd: 200,
      percent_of_pool: 95.7,
      override_threshold_pct: 80,
      hardstop_threshold_pct: 95,
      projected_eom_usd: 240.0,
    })

    const result = await runAgent(
      'do something',
      undefined,
      undefined,
      false,
      undefined,
      { projectId: 'test-project', source: 'test' },
    )

    expect(result.text).toMatch(/pool hard-stop reached/i)
    expect(result.text).toContain('$191.42')
    expect(result.text).toContain('$200')
    expect(result.emptyReason).toMatch(/agent sdk pool exceeded/i)
    expect(runtime.runAgentWithResolvedExecution).not.toHaveBeenCalled()
  })

  it('pool gate override_to_ollama: runtime called with provider ollama', async () => {
    vi.mocked(costGateMod.getPoolGateStatus).mockResolvedValue({
      action: 'override_to_ollama',
      spend_usd: 161.0,
      cap_usd: 200,
      percent_of_pool: 80.5,
      override_threshold_pct: 80,
      hardstop_threshold_pct: 95,
      projected_eom_usd: 195.0,
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


  it('pool gate refuse runs BEFORE per-project gate (account exhaust beats project allowance)', async () => {
    // Pool says refuse; project says allow — pool wins.
    vi.mocked(costGateMod.getPoolGateStatus).mockResolvedValue({
      action: 'refuse',
      spend_usd: 195,
      cap_usd: 200,
      percent_of_pool: 97.5,
      override_threshold_pct: 80,
      hardstop_threshold_pct: 95,
      projected_eom_usd: 240,
    })
    vi.mocked(costGateMod.getCostGateStatus).mockResolvedValue({
      action: 'allow',
      percent_of_cap: 10,
      mtd_usd: 2,
      today_usd: 0.1,
      monthly_cap_usd: 50,
      daily_cap_usd: null,
      triggering_cap: null,
    })

    const result = await runAgent(
      'do something',
      undefined,
      undefined,
      false,
      undefined,
      { projectId: 'test-project', source: 'test' },
    )

    expect(result.text).toMatch(/pool hard-stop reached/i)
    // Per-project gate was never consulted because pool refused first.
    expect(runtime.runAgentWithResolvedExecution).not.toHaveBeenCalled()
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
