import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

const HOUR = 3_600_000
const kv = new Map<string, string>()
let db: InstanceType<typeof Database>

vi.mock('../db.js', () => ({
  getDb: vi.fn(() => db),
  getKnob: vi.fn((_p: string, _k: string, fallback: string) => fallback),
  getKvSetting: vi.fn((key: string) => kv.get(key) ?? null),
  setKvSetting: vi.fn((key: string, value: string) => { kv.set(key, value) }),
}))
vi.mock('../telemetry-db.js', () => ({
  getTelemetryDb: vi.fn(() => ({ prepare: vi.fn(() => ({ get: vi.fn(() => ({ n: 0 })) })) })),
}))
vi.mock('../config.js', () => ({ ALLOWED_CHAT_ID: '1', DASHBOARD_URL: 'http://dash' }))
vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { shouldDrainNow, holdMessage, flushHeld, shouldHold } from './quiet-hours.js'
import { renderDigestText } from '../reports/digest-text.js'
import { fixture } from '../reports/digest-fixture.js'

// 2026-09-02T12:30Z = 08:30 ET, 2026-09-02T13:30Z = 09:30 ET
const at8am = Date.parse('2026-09-02T12:30:00Z')
const at9am = Date.parse('2026-09-02T13:30:00Z')
// 2026-09-02T14:30Z = 10:30 ET, 2026-09-02T11:30Z = 07:30 ET
const at10am = Date.parse('2026-09-02T14:30:00Z')
const at7am = Date.parse('2026-09-02T11:30:00Z')

describe('shouldDrainNow', () => {
  it('fires from 08:00 local onwards, not only inside the 08:00 hour', () => {
    expect(shouldDrainNow(at8am, null)).toBe(true)
    expect(shouldDrainNow(at9am, null)).toBe(true)
    // A bot that was down across 08:00 and comes back at 10:00 still drains.
    expect(shouldDrainNow(at10am, null)).toBe(true)
    expect(shouldDrainNow(at7am, null)).toBe(false)
  })

  it('fires once per local day', () => {
    expect(shouldDrainNow(at10am, at8am)).toBe(false)
    expect(shouldDrainNow(at8am, at8am - 13 * HOUR)).toBe(true)
  })

  // The window runs to the end of the day and the scheduler ticks every 60s,
  // so a failed send must back off instead of rebuilding the report each tick.
  it('waits 10 minutes after a failed attempt before retrying', () => {
    expect(shouldDrainNow(at10am, null, at10am - 60_000)).toBe(false)
    expect(shouldDrainNow(at10am, null, at10am - 9 * 60_000)).toBe(false)
    expect(shouldDrainNow(at10am, null, at10am - 11 * 60_000)).toBe(true)
    expect(shouldDrainNow(at10am, null, null)).toBe(true)
  })
})

describe('flushHeld grouping', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    kv.clear()
    kv.set('notify.last_flush_ms', String(Date.now())) // skip the failure-count send in this suite
  })

  it('groups held messages by project under one "Handled without you" body', async () => {
    holdMessage('telegram', '1', 'trader cycle finished', 'trader')
    holdMessage('telegram', '1', 'example-company cron ran', 'example-company')

    const sent: string[] = []
    const n = await flushHeld(async (_c, _chat, text) => { sent.push(text) })

    expect(n).toBe(2)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Handled without you')
    expect(sent[0]).toContain('trader (1):')
    expect(sent[0]).toContain('example-company (1):')
    expect(sent[0]).toContain('trader cycle finished')
    expect(sent[0]).toContain('example-company cron ran')
  })

  it('drains rows with no project under "other"', async () => {
    holdMessage('telegram', '1', 'unattributed message')
    const sent: string[] = []
    await flushHeld(async (_c, _chat, text) => { sent.push(text) })
    expect(sent[0]).toContain('other (1):')
  })

  // Final fix C13: the 12h nudge used to render in the digest text and again
  // in this drain, so the 08:00 message named the same parked routine twice.
  it('leaves the 12h parked-routine nudge to the digest text', async () => {
    db.exec(`
      CREATE TABLE paws (id TEXT PRIMARY KEY, name TEXT, project_id TEXT, status TEXT);
      CREATE TABLE paw_cycles (id INTEGER PRIMARY KEY, paw_id TEXT, started_at INTEGER);
    `)
    db.prepare("INSERT INTO paws VALUES ('p1', 'Retrain regime', 'trader', 'waiting_approval')").run()
    db.prepare('INSERT INTO paw_cycles (paw_id, started_at) VALUES (?, ?)')
      .run('p1', Date.now() - 20 * HOUR)
    holdMessage('telegram', '1', 'trader cycle finished', 'trader')

    const sent: string[] = []
    await flushHeld(async (_c, _chat, text) => { sent.push(text) })

    expect(sent[0]).not.toContain('Retrain regime')
    expect(sent[0]).not.toContain('Waiting on you for more than 12h')

    // The whole 08:00 Telegram output is the digest text plus this drain.
    const eightAmOutput = [renderDigestText(fixture), ...sent].join('\n')
    expect(eightAmOutput.match(/Retrain regime/g)).toHaveLength(1)
  })
})

// ChannelManager.send calls shouldHold, not isTraderIssue, so this is the gate
// that actually decides whether a trader failure waits until 08:00.
describe('shouldHold, the gate ChannelManager uses', () => {
  it('sends a trader engine failure at once and holds a routine paw line', () => {
    expect(shouldHold('TRADER: Engine unreachable for 10 min. SSH restart issued')).toBe(false)
    expect(shouldHold('TRADER ALERT: kill switch engaged')).toBe(false)
    expect(shouldHold('could not fetch the RSS feed')).toBe(true)
    expect(shouldHold('The Trader scout could not find a new listing today')).toBe(true)
    expect(shouldHold('Trader (needs you): the trading service stopped responding 20 minutes ago')).toBe(false)
    expect(shouldHold('Handled without you: 3 routines')).toBe(true)
    expect(shouldHold('Weekly Social Report: nothing new')).toBe(true)
  })
})
