import { describe, it, expect, vi, beforeEach } from 'vitest'

const knobs = new Map<string, string>()

vi.mock('../db.js', () => ({
  getKnob: vi.fn((projectId: string, key: string, fallback: string) => knobs.get(`${projectId}:${key}`) ?? fallback),
  getDb: vi.fn(() => ({ exec: vi.fn(), prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })) })),
  getKvSetting: vi.fn(() => null),
  setKvSetting: vi.fn(),
}))
vi.mock('../telemetry-db.js', () => ({ getTelemetryDb: vi.fn(() => ({ prepare: vi.fn(() => ({ get: vi.fn(() => ({ n: 0 })) })) })) }))
vi.mock('../config.js', () => ({ ALLOWED_CHAT_ID: '1', DASHBOARD_URL: '' }))
vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { digestMode, shouldHold } from './quiet-hours.js'

// 2026-09-02T02:30Z = 22:30 ET (inside the default quiet window)
const night = new Date('2026-09-02T02:30:00Z')
// 2026-09-02T18:30Z = 14:30 ET (outside it)
const day = new Date('2026-09-02T18:30:00Z')

describe('digest mode', () => {
  beforeEach(() => knobs.clear())

  it('defaults to daily', () => {
    expect(digestMode()).toBe('daily')
  })

  it('daily holds routine messages at every hour and lets urgent through', () => {
    expect(shouldHold('Cycle report: nothing changed', day)).toBe(true)
    expect(shouldHold('Cycle report: nothing changed', night)).toBe(true)
    expect(shouldHold('NAV drop 6 percent, trading halted', day)).toBe(false)
  })

  it('off keeps the quiet-hours behavior', () => {
    knobs.set('default:digest_mode', 'off')
    knobs.set('default:quiet_hours', '21-8')
    expect(shouldHold('Cycle report: nothing changed', day)).toBe(false)
    expect(shouldHold('Cycle report: nothing changed', night)).toBe(true)
    expect(shouldHold('kill switch tripped', night)).toBe(false)
  })
})
