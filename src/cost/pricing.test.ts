import { describe, it, expect } from 'vitest'
import { computeCostUsd } from './pricing.js'

describe('computeCostUsd', () => {
  it('returns 0 for ollama (free)', () => {
    expect(computeCostUsd('ollama', { input_tokens: 1000, output_tokens: 500 })).toBe(0)
    expect(computeCostUsd('lm-studio', { input_tokens: 1000 })).toBe(0)
  })

  it('returns 0 for zero-token usage', () => {
    expect(computeCostUsd('claude-sonnet-4-6', { input_tokens: 0, output_tokens: 0 })).toBe(0)
  })

  it('computes Claude Sonnet 4.6 cost (3/15 per 1M)', () => {
    // 1M input + 1M output should be ~$18
    const cost = computeCostUsd('claude-sonnet-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(18, 1)
  })

  it('includes cache read/write pricing when supported', () => {
    const cost = computeCostUsd('claude-sonnet-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    })
    // 0.30 for cache reads + 3.75 for cache writes = 4.05
    expect(cost).toBeCloseTo(4.05, 2)
  })

  it('fuzzy-matches family names (anthropic/claude-sonnet-4-5 → claude-sonnet-4-5)', () => {
    const cost = computeCostUsd('anthropic/claude-sonnet-4-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(18, 1)
  })

  it('fuzzy-matches family with version suffix (claude-sonnet-4-5-20250522)', () => {
    const cost = computeCostUsd('claude-sonnet-4-5-20250522', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(18, 1)
  })

  it('returns null for unknown model with non-zero usage (attributed as unpriced)', () => {
    expect(computeCostUsd('future-model-x', { input_tokens: 1000 })).toBeNull()
  })

  it('returns null for null usage', () => {
    expect(computeCostUsd('claude-sonnet-4-6', null)).toBeNull()
  })

  it('computes gpt-4o cost (2.50/10.00 per 1M)', () => {
    const cost = computeCostUsd('gpt-4o', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(12.5, 1)
  })

  it('computes Haiku cost at budget rate', () => {
    const cost = computeCostUsd('claude-haiku-4-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(4.8, 1) // 0.80 + 4.00
  })
})
