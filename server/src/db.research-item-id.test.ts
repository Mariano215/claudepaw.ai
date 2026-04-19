import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { ensureActionItemsResearchLink } from './db.js'

describe('ensureActionItemsResearchLink', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE action_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `)
  })

  afterEach(() => { db.close() })

  it('adds research_item_id column when missing', () => {
    ensureActionItemsResearchLink(db)
    const cols = db.prepare("PRAGMA table_info(action_items)").all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('research_item_id')
  })

  it('is idempotent: running twice does not throw', () => {
    ensureActionItemsResearchLink(db)
    expect(() => ensureActionItemsResearchLink(db)).not.toThrow()
  })

  it('creates idx_action_items_research index', () => {
    ensureActionItemsResearchLink(db)
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_action_items_research'"
    ).get()
    expect(idx).toBeTruthy()
  })
})
