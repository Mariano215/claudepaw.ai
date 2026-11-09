import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase, checkpointAndCloseDatabase, getDb, upsertProjectSettings, getProjectSettings } from './db.js'

function seedProject(id: string): void {
  getDb()
    .prepare(`INSERT INTO projects (id, name, slug, display_name, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, id, id, id, Date.now())
}

describe('project_settings cost cap columns', () => {
  beforeEach(() => {
    process.env.DB_PATH = ':memory:'
    initDatabase()
  })

  afterEach(() => {
    checkpointAndCloseDatabase()
    delete process.env.DB_PATH
  })

  it('persists monthly_cost_cap_usd', () => {
    seedProject('p1')
    upsertProjectSettings({ project_id: 'p1', monthly_cost_cap_usd: 123.45 })
    const settings = getProjectSettings('p1')
    expect(settings?.monthly_cost_cap_usd).toBe(123.45)
  })

  it('persists daily_cost_cap_usd', () => {
    seedProject('p1')
    upsertProjectSettings({ project_id: 'p1', daily_cost_cap_usd: 9.99 })
    const settings = getProjectSettings('p1')
    expect(settings?.daily_cost_cap_usd).toBe(9.99)
  })

  it('returns null for both caps when unset', () => {
    seedProject('p1')
    upsertProjectSettings({ project_id: 'p1', theme_id: 'default' })
    const settings = getProjectSettings('p1')
    expect(settings?.monthly_cost_cap_usd).toBeNull()
    expect(settings?.daily_cost_cap_usd).toBeNull()
  })
})
