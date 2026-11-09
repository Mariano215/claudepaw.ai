import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { ensureActionItemsResearchLink } from './db.js'

// Helper wrapping db.prepare().run() for DDL so the test does not collide
// with naming assumptions elsewhere. better-sqlite3 supports this for
// single-statement DDL.
function ddl(db: Database.Database, sql: string): void {
  db.prepare(sql).run()
}

describe('ensureActionItemsResearchLink (bot-side)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    // action_items must exist -- the helper documents this prerequisite
    ddl(db, `
      CREATE TABLE action_items (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `)
  })

  it('adds the research_item_id column when missing', () => {
    const before = db.prepare(`PRAGMA table_info(action_items)`).all() as Array<{ name: string }>
    expect(before.some(c => c.name === 'research_item_id')).toBe(false)

    ensureActionItemsResearchLink(db)

    const after = db.prepare(`PRAGMA table_info(action_items)`).all() as Array<{ name: string }>
    expect(after.some(c => c.name === 'research_item_id')).toBe(true)
  })

  it('is idempotent: running twice does not throw or duplicate the column', () => {
    ensureActionItemsResearchLink(db)
    expect(() => ensureActionItemsResearchLink(db)).not.toThrow()

    const cols = db.prepare(`PRAGMA table_info(action_items)`).all() as Array<{ name: string }>
    const researchCols = cols.filter(c => c.name === 'research_item_id')
    expect(researchCols).toHaveLength(1)
  })

  it('creates the supporting index', () => {
    ensureActionItemsResearchLink(db)
    const idx = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name=?`,
    ).get('idx_action_items_research') as { name: string } | undefined
    expect(idx?.name).toBe('idx_action_items_research')
  })

  it('surfaces a clear error when action_items table is missing (no silent swallow)', () => {
    const bare = new Database(':memory:')
    try {
      // Without the prerequisite table, ALTER TABLE throws. The helper does NOT
      // catch this -- confirms we replaced the old silent try/catch pattern with
      // a loud failure mode on prerequisite violations.
      expect(() => ensureActionItemsResearchLink(bare)).toThrow()
    } finally {
      bare.close()
    }
  })
})
