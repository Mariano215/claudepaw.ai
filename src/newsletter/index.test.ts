import { describe, it, expect } from 'vitest'
import { computeEditionId, computeEditionDate, heroStatusLabel } from './index.js'

describe('newsletter orchestrator helpers', () => {
  it('generates a stable edition ID for a given date', () => {
    const id = computeEditionId('2026-04-03')
    expect(id).toBe('signal-2026-04-03')
  })

  it('computes edition date as YYYY-MM-DD', () => {
    const date = computeEditionDate()
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('heroStatusLabel', () => {
  it('reports OK when the email carries an inlined hero', () => {
    expect(heroStatusLabel('data:image/jpeg;base64,abc')).toBe('OK')
  })

  // Regression: Aug 10 and Aug 17 2026 shipped bare because a rejected Gemini
  // key was swallowed and the summary still read a clean success.
  it('reports MISSING with the reason when generation fell back', () => {
    expect(heroStatusLabel('', 'api-error')).toBe('MISSING (api-error)')
  })

  it('reports MISSING when optimize dropped the image with no reason', () => {
    expect(heroStatusLabel('')).toBe('MISSING')
  })
})
