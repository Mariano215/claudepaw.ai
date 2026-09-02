import { describe, it, expect } from 'vitest'
import { isQuietNow, isUrgent, parseWindow } from './quiet-hours.js'

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
})
