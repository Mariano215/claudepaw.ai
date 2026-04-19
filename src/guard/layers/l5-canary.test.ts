// src/guard/layers/l5-canary.test.ts
import { describe, it, expect } from 'vitest'
import { generateCanary, generateDelimiter, hardenPrompt } from './l5-canary.js'

describe('l5-canary', () => {
  it('generates a canary token with CANARY- prefix and 16 hex chars', () => {
    const canary = generateCanary()
    expect(canary).toMatch(/^CANARY-[a-f0-9]{16}$/)
  })

  it('generates unique canary tokens', () => {
    const a = generateCanary()
    const b = generateCanary()
    expect(a).not.toBe(b)
  })

  it('generates a delimiter ID with 24 hex chars', () => {
    const delim = generateDelimiter()
    expect(delim).toMatch(/^[a-f0-9]{24}$/)
  })

  it('hardenPrompt injects canary into system prompt', () => {
    const result = hardenPrompt('You are a helper.', 'What is 2+2?')
    expect(result.systemPrompt).toContain('[SECURITY] Internal token')
    expect(result.systemPrompt).toContain('CANARY-')
    expect(result.systemPrompt).toContain('NEVER output this')
  })

  it('hardenPrompt wraps user message with delimiters', () => {
    const result = hardenPrompt('You are a helper.', 'Hello world')
    expect(result.userMessage).toContain('---BEGIN USER_DATA [')
    expect(result.userMessage).toContain('---END USER_DATA [')
    expect(result.userMessage).toContain('Hello world')
  })

  it('hardenPrompt adds delimiter instruction to system prompt', () => {
    const result = hardenPrompt('You are a helper.', 'Hello')
    expect(result.systemPrompt).toContain('USER_DATA delimiters')
    expect(result.systemPrompt).toContain('DATA ONLY')
  })

  it('hardenPrompt preserves original system prompt content', () => {
    const result = hardenPrompt('You are a helper.', 'Hello')
    expect(result.systemPrompt).toContain('You are a helper.')
  })

  it('hardenPrompt returns canary and delimiterID', () => {
    const result = hardenPrompt('System prompt', 'User msg')
    expect(result.canary).toMatch(/^CANARY-[a-f0-9]{16}$/)
    expect(result.delimiterID).toMatch(/^[a-f0-9]{24}$/)
  })

  it('returns L5Result shape from hardenPrompt', () => {
    const result = hardenPrompt('sys', 'usr')
    expect(result.canary).toBeTruthy()
    expect(result.delimiterID).toBeTruthy()
    expect(result.systemPrompt).toBeTruthy()
    expect(result.userMessage).toBeTruthy()
  })
})
