import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSocialTables, setSocialDb, createDraft, getPost } from './db.js'
import { etToUtc, slotFor, isDue, parsePlan, buildPlanCard, queueDrafts } from './autopilot.js'

describe('social/autopilot', () => {
  beforeEach(() => {
    const db = new Database(':memory:')
    initSocialTables(db)
    setSocialDb(db)
  })

  it('converts ET wall time to UTC across DST', () => {
    expect(new Date(etToUtc(2026, 7, 15, 10)).toISOString()).toBe('2026-07-15T14:00:00.000Z') // EDT
    expect(new Date(etToUtc(2026, 12, 15, 10)).toISOString()).toBe('2026-12-15T15:00:00.000Z') // EST
  })

  it('slots next week from a Sunday evening run', () => {
    const sunEvening = Date.parse('2026-09-27T22:00:00Z') // Sun 6pm EDT
    expect(new Date(slotFor('Mon', sunEvening)).toISOString()).toBe('2026-09-28T14:00:00.000Z')
    expect(new Date(slotFor('Fri', sunEvening)).toISOString()).toBe('2026-10-02T14:00:00.000Z')
    expect(new Date(slotFor('bogus', sunEvening)).toISOString()).toBe('2026-09-28T14:00:00.000Z')
  })

  it('runs only Sunday 17:00+ ET, once a week', () => {
    const sun6pm = Date.parse('2026-09-27T22:00:00Z')
    expect(isDue(sun6pm, null)).toBe(true)
    expect(isDue(Date.parse('2026-09-27T19:00:00Z'), null)).toBe(false) // Sun 3pm
    expect(isDue(Date.parse('2026-09-28T22:00:00Z'), null)).toBe(false) // Mon
    expect(isDue(sun6pm + 60_000, sun6pm)).toBe(false)
    expect(isDue(sun6pm + 7 * 86_400_000, sun6pm)).toBe(true)
  })

  it('parses a fenced plan, caps count, and fills short from long', () => {
    const raw = '```json\n{"posts":[{"day":"Tuesday","long":"A","link":"https://x.com/a"},{"day":"Wed","long":"B","short":"b","link":null},{"day":"Thu","long":"C"}]}\n```'
    const plan = parsePlan(raw, 2)
    expect(plan).toEqual([
      { day: 'Tue', long: 'A', short: 'A', link: 'https://x.com/a' },
      { day: 'Wed', long: 'B', short: 'b', link: null },
    ])
  })

  it('queues drafts at their planned time, or soon if it passed; card carries all ids', () => {
    const now = Date.parse('2026-09-27T22:00:00Z')
    const future = createDraft({ platform: 'facebook', content: 'hi', project_id: 'example-company', suggested_time: '2026-09-29T14:00:00.000Z' })
    const past = createDraft({ platform: 'linkedin', content: 'hi', project_id: 'example-company', suggested_time: '2026-09-01T14:00:00.000Z' })
    const card = buildPlanCard('Example Company', [future, past])
    expect(card.keyboard.inline_keyboard[0][0].callback_data).toBe(`social:queue:${future.id},${past.id}`)
    expect(queueDrafts([future.id, past.id], now)).toBe(2)
    expect(getPost(future.id)).toMatchObject({ status: 'approved', scheduled_at: Date.parse('2026-09-29T14:00:00.000Z') })
    expect(getPost(past.id)!.scheduled_at).toBe(now + 5 * 60 * 1000)
    expect(queueDrafts([future.id], now)).toBe(0) // double tap is a no-op
  })
})
