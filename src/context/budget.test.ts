import { describe, it, expect } from 'vitest'
import { createBudget, estimateTokens, fitToBudget } from './budget.js'

describe('estimateTokens', () => {
  it('~4 chars per token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('test')).toBe(1)
    expect(estimateTokens('a'.repeat(100))).toBe(25)
  })
})

describe('createBudget', () => {
  it('tracks remaining', () => {
    const b = createBudget(1000); b.consume(250)
    expect(b.remaining).toBe(750)
  })
  it('reports exhaustion', () => {
    const b = createBudget(100); b.consume(150)
    expect(b.exhausted).toBe(true)
  })
})

describe('fitToBudget', () => {
  it('returns full text under budget', () => {
    expect(fitToBudget('short', 1000)).toBe('short')
  })
  it('truncates over budget with suffix', () => {
    const r = fitToBudget('a'.repeat(1000), 50)
    expect(r).toMatch(/\.\.\. \[truncated\]$/)
    expect(r.length).toBeLessThan(1000)
  })
})
