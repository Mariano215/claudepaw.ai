import { describe, it, expect } from 'vitest'
import { computeEditionId, computeEditionDate, heroStatusLabel, resolveLinkedinGate } from './index.js'

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

describe('resolveLinkedinGate (the social.post gate for the LinkedIn newsletter leg)', () => {
  it('deny: publishes nothing and yields REFUSED (policy)', () => {
    const gate = resolveLinkedinGate('deny')
    expect(gate.publish).toBe(false)
    expect(gate.heldStatus).toBe('REFUSED (policy)')
  })

  it('pending: publishes nothing and yields HELD (card <id>)', () => {
    const gate = resolveLinkedinGate('pending:card-7')
    expect(gate.publish).toBe(false)
    expect(gate.heldStatus).toBe('HELD (card card-7)')
  })

  it('allow: clears the publish and reports no held status', () => {
    const gate = resolveLinkedinGate('allow')
    expect(gate.publish).toBe(true)
    expect(gate.heldStatus).toBeUndefined()
  })
})
