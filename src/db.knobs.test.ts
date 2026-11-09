// The dashboard Knobs card writes action_policy as a nested JSON object, not
// as a string. getKnob used to String() that into "[object Object]", so
// getActionPolicy's JSON.parse threw and every policy an operator set on the
// dashboard silently fell back to the default. In-memory DB only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, checkpointAndCloseDatabase, getDb, getKnob, upsertProjectSettings } from './db.js'
import { getActionPolicy } from './policy.js'

function seedProject(id: string, knobs: Record<string, unknown>): void {
  getDb()
    .prepare(`INSERT INTO projects (id, name, slug, display_name, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, id, id, id, Date.now())
  upsertProjectSettings({ project_id: id, knobs: JSON.stringify(knobs) })
}

describe('getKnob', () => {
  beforeEach(() => {
    process.env.DB_PATH = ':memory:'
    initDatabase()
  })

  afterEach(() => {
    checkpointAndCloseDatabase()
    delete process.env.DB_PATH
  })

  it('returns an object knob as its JSON, not as [object Object]', () => {
    seedProject('p1', { action_policy: { 'social.post': 'never' } })
    const raw = getKnob('p1', 'action_policy', '')
    expect(raw).toBe('{"social.post":"never"}')
    expect(JSON.parse(raw)).toEqual({ 'social.post': 'never' })
  })

  it('reads a dashboard-set action_policy through getActionPolicy', () => {
    seedProject('p2', { action_policy: { 'social.post': 'never' } })
    expect(getActionPolicy('p2')['social.post']).toBe('never')
    expect(getActionPolicy('p2')['code.merge']).toBe('ask')
  })

  it('still reads a knob stored as a plain string', () => {
    seedProject('p3', { quiet_hours: '21-8', action_policy: '{"email.send":"never"}' })
    expect(getKnob('p3', 'quiet_hours', 'off')).toBe('21-8')
    expect(getActionPolicy('p3')['email.send']).toBe('never')
  })
})
