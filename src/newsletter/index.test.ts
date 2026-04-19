import { describe, it, expect } from 'vitest'
import { computeEditionId, computeEditionDate } from './index.js'

describe('newsletter orchestrator helpers', () => {
  it('generates a stable edition ID for a given date', () => {
    const id = computeEditionId('2026-04-03')
    expect(id).toBe('asymmetry-2026-04-03')
  })

  it('computes edition date as YYYY-MM-DD', () => {
    const date = computeEditionDate()
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
