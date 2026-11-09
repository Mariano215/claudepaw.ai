import { describe, it, expect, vi, beforeEach } from 'vitest'
import { embedBatchOptimized, embedWithRetry } from './ollama-enhanced.js'
import * as base from '../embeddings.js'

describe('embedBatchOptimized', () => {
  beforeEach(() => vi.restoreAllMocks())
  it('dedups duplicate texts', async () => {
    const spy = vi.spyOn(base, 'embedText').mockResolvedValue([0.5])
    await embedBatchOptimized(['same','same','same'])
    expect(spy).toHaveBeenCalledTimes(1)
  })
  it('parallel order preserved', async () => {
    vi.spyOn(base, 'embedText').mockImplementation(async t => t === 'a' ? [0.1] : [0.2])
    const r = await embedBatchOptimized(['a','b'])
    expect(r[0]).toEqual([0.1]); expect(r[1]).toEqual([0.2])
  })
  it('empty input returns empty', async () => {
    expect(await embedBatchOptimized([])).toEqual([])
  })
})

describe('embedWithRetry', () => {
  it('retries on empty and eventually succeeds', async () => {
    let n = 0
    vi.spyOn(base, 'embedText').mockImplementation(async () => { n++; return n < 3 ? [] : [1,2,3] })
    const r = await embedWithRetry('t', { maxAttempts: 3, baseDelayMs: 1 })
    expect(r).toEqual([1,2,3]); expect(n).toBe(3)
  })
  it('returns empty after exhausting retries', async () => {
    vi.spyOn(base, 'embedText').mockResolvedValue([])
    expect(await embedWithRetry('t', { maxAttempts: 2, baseDelayMs: 1 })).toEqual([])
  })
})
