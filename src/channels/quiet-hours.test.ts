import { describe, it, expect } from 'vitest'
import { isQuietNow, isUrgent, parseWindow, traderNeedsOperator } from './quiet-hours.js'

// 2026-09-02T02:30Z = 22:30 ET (quiet), 2026-09-02T14:30Z = 10:30 ET (open)
const night = new Date('2026-09-02T02:30:00Z')
const day = new Date('2026-09-02T14:30:00Z')

describe('quiet hours', () => {
  it('holds routine messages at night and releases by day', () => {
    expect(isQuietNow(night, '21-8')).toBe(true)
    expect(isQuietNow(day, '21-8')).toBe(false)
  })
  it('supports a window that does not wrap midnight and an off switch', () => {
    expect(isQuietNow(day, '9-12')).toBe(true)
    expect(isQuietNow(night, '9-12')).toBe(false)
    expect(isQuietNow(night, 'off')).toBe(false)
    expect(parseWindow('25-3')).toBeNull()
  })
  it('lets urgent alerts and approval messages through', () => {
    expect(isUrgent('ALERT: NAV drop 5%, orders halted')).toBe(true)
    expect(isUrgent('Paw needs your approval')).toBe(true)
    expect(isUrgent('Weekly Social Report: nothing new')).toBe(false)
  })
  it('treats the trader issue terms as urgent too, so one regex decides', () => {
    expect(isUrgent('TRADER ALERT: UNEXPECTED SHORT POSITION')).toBe(true)
    expect(isUrgent('TRADER ALERT: halt')).toBe(true)
    expect(isUrgent('engine submit rejected for SPY')).toBe(true)
    // Generic words, but behind a TRADER prefix.
    expect(isUrgent('TRADER: Engine unreachable for 10 min. SSH restart issued')).toBe(true)
    expect(isUrgent('TRADER: could not reconcile positions')).toBe(true)
    // Anchored to a line start, so prose naming a trader mid-sentence stays
    // routine.
    expect(isUrgent('The Trader scout could not find a new listing today')).toBe(false)
  })

  // Plain-English alerts name no failure keyword, so the owner-attention
  // marker is what makes them urgent.
  it('treats the needs-you marker as urgent, and the handled digest as routine', () => {
    expect(isUrgent('Trader (needs you): the trading service stopped responding 20 minutes ago')).toBe(true)
    expect(isUrgent('Handled without you: 3 routines')).toBe(false)
  })
  // The generic terms woke the operator on routine paw reports, which is what
  // the digest buffer exists to prevent.
  it('keeps the generic failure words routine', () => {
    expect(isUrgent('could not fetch the RSS feed')).toBe(false)
    expect(isUrgent('The festival site was unreachable, retrying tomorrow')).toBe(false)
    expect(isUrgent('The scan did not start because the feed was empty')).toBe(false)
    expect(isUrgent('Alert level is green, nothing to do')).toBe(false)
  })
  it('still lets ordinary trading updates be routine', () => {
    expect(isUrgent('Trading update (since the last one): bought SPY')).toBe(false)
    expect(isUrgent('EXECUTED: BUY SPY $100')).toBe(false)
  })
})

describe('trader bot speaks only when the operator must act', () => {
  it('sends alerts and asks, drops status and reports', () => {
    expect(traderNeedsOperator('TRADER ALERT: UNEXPECTED SHORT POSITION: IWM -3.')).toBe(true)
    expect(traderNeedsOperator('NAV drop halt: $1,000 (6%) over 7 days.')).toBe(true)
    expect(traderNeedsOperator('Trader (needs you): engine stuck\nWhat to do: restart it')).toBe(true)
    expect(traderNeedsOperator('EXECUTED: BUY DBC $500 @ market. Committee: approved')).toBe(false)
    expect(traderNeedsOperator('Go-live gate: 1/8 criteria (0 closed round-trips)')).toBe(false)
    expect(traderNeedsOperator('Paw Trader weekly report 2026-09-13. Kill switch: inactive')).toBe(false)
    expect(traderNeedsOperator('Trader: order retried\nNothing for you to do.')).toBe(false)
  })
})
