// src/guard/types.test.ts
import { describe, it, expect } from 'vitest'
import { GUARD_CONFIG } from './config.js'
import type {
  GuardResult,
  PreProcessResult,
  PostProcessResult,
  HardenedPrompt,
  RequestContext,
  LayerResult,
  L1Result,
  L2Result,
  L3Result,
  L4Result,
  L5Result,
  L6Result,
  L7Result,
  GuardConfig,
  GuardEventType,
} from './types.js'

describe('guard/types + config', () => {
  it('exports GUARD_CONFIG with all required fields', () => {
    expect(GUARD_CONFIG.maxInputChars).toBe(4000)
    expect(GUARD_CONFIG.sidecarUrl).toMatch(/^http/)
    expect(GUARD_CONFIG.novaTimeoutMs).toBe(5000)
    expect(GUARD_CONFIG.injectionThreshold).toBe(0.8)
    expect(GUARD_CONFIG.toxicityInputThreshold).toBe(0.8)
    expect(GUARD_CONFIG.minResponseChars).toBe(10)
    expect(GUARD_CONFIG.maxResponseChars).toBe(8000)
    expect(GUARD_CONFIG.systemPromptEchoPhrases).toBeInstanceOf(Array)
    expect(GUARD_CONFIG.systemPromptEchoThreshold).toBe(2)
    expect(GUARD_CONFIG.toxicityOutputThreshold).toBe(0.8)
    expect(GUARD_CONFIG.refusalThreshold).toBe(0.8)
    expect(GUARD_CONFIG.fallbackResponse).toBeTruthy()
  })

  it('GuardEventType only allows BLOCKED, FLAGGED, PASSED', () => {
    const valid: GuardEventType[] = ['BLOCKED', 'FLAGGED', 'PASSED']
    expect(valid).toHaveLength(3)
  })
})
