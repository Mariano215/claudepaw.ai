import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { getDb, initDatabase } from '../db.js'
import { upsertEntity } from '../knowledge.js'
import { runDailyDecay, decayObservationsByKind } from './decay.js'

beforeAll(() => initDatabase())

describe('decayObservationsByKind', () => {
  beforeEach(() => {
    const db = getDb()
    db.prepare("DELETE FROM observations WHERE entity_id IN (SELECT id FROM entities WHERE name LIKE 'decay-test-%')").run()
    db.prepare("DELETE FROM entities WHERE name LIKE 'decay-test-%'").run()
  })

  it('lowers confidence but respects floor', () => {
    const id = upsertEntity({ name: 'decay-test-event', type: 'event', summary: 't', projectId: 'default' })
    getDb().prepare(`INSERT INTO observations (entity_id, content, valid_from, source, confidence, created_at) VALUES (?,?,?,?,?,?)`).run(id, 'x', Date.now(), 'test', 1.0, Date.now())
    for (let i = 0; i < 100; i++) decayObservationsByKind(['event'], 0.005, 0.3)
    const row = getDb().prepare(`SELECT MIN(confidence) c FROM observations WHERE entity_id = ?`).get(id) as { c: number }
    expect(row.c).toBeGreaterThanOrEqual(0.3)
  })

  it('does not delete entities', () => {
    const id = upsertEntity({ name: 'decay-test-pref', type: 'preference', summary: 't', projectId: null })
    for (let i = 0; i < 200; i++) runDailyDecay()
    expect(getDb().prepare('SELECT id FROM entities WHERE id = ?').get(id)).toBeTruthy()
  })
})
