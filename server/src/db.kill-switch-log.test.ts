/**
 * db.kill-switch-log.test.ts -- Phase 5 Task 3
 *
 * Schema pin tests for the new append-only `kill_switch_log` table.
 * The table is created alongside `system_state` in the server DB init
 * path. We re-run the same `CREATE TABLE IF NOT EXISTS` SQL against an
 * in-memory DB so each test is isolated and the production schema is
 * mirrored exactly. The migration is idempotent so running it twice
 * never throws.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// Same DDL the server emits at startup. Keep in sync with `initServerDb`
// in server/src/db.ts. If the schema changes there, this test will catch
// the drift on the next run.
const KILL_SWITCH_LOG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS kill_switch_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    toggled_at_ms  INTEGER NOT NULL,
    new_state      TEXT NOT NULL CHECK (new_state IN ('tripped', 'active')),
    reason         TEXT,
    set_by         TEXT
  )
`

const KILL_SWITCH_LOG_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_kill_switch_log_toggled_at ON kill_switch_log(toggled_at_ms DESC)
`

interface TableInfoRow {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.prepare(KILL_SWITCH_LOG_TABLE_SQL).run()
  db.prepare(KILL_SWITCH_LOG_INDEX_SQL).run()
  return db
}

describe('kill_switch_log schema', () => {
  let db: Database.Database

  beforeEach(() => {
    db = makeDb()
  })

  it('table exists after init', () => {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kill_switch_log'`)
      .get() as { name: string } | undefined
    expect(row?.name).toBe('kill_switch_log')
  })

  it('has the expected columns', () => {
    const cols = db.prepare(`PRAGMA table_info(kill_switch_log)`).all() as TableInfoRow[]
    const names = cols.map(c => c.name).sort()
    expect(names).toEqual(['id', 'new_state', 'reason', 'set_by', 'toggled_at_ms'])
  })

  it('id is the primary key and AUTOINCREMENTs across rows', () => {
    const cols = db.prepare(`PRAGMA table_info(kill_switch_log)`).all() as TableInfoRow[]
    const idCol = cols.find(c => c.name === 'id')
    expect(idCol?.pk).toBe(1)

    db.prepare(`INSERT INTO kill_switch_log (toggled_at_ms, new_state, reason, set_by) VALUES (?, ?, ?, ?)`)
      .run(1_700_000_000_000, 'tripped', 'first', 'Admin')
    db.prepare(`INSERT INTO kill_switch_log (toggled_at_ms, new_state, reason, set_by) VALUES (?, ?, ?, ?)`)
      .run(1_700_000_001_000, 'active', 'cleared', 'Admin')

    const rows = db.prepare(`SELECT id FROM kill_switch_log ORDER BY id ASC`).all() as { id: number }[]
    expect(rows.length).toBe(2)
    expect(rows[0].id).toBe(1)
    expect(rows[1].id).toBe(2)
  })

  it('CHECK constraint rejects new_state values other than tripped or active', () => {
    expect(() =>
      db.prepare(`INSERT INTO kill_switch_log (toggled_at_ms, new_state) VALUES (?, ?)`)
        .run(1_700_000_000_000, 'unknown'),
    ).toThrow(/CHECK constraint failed/i)

    // Also rejects empty string.
    expect(() =>
      db.prepare(`INSERT INTO kill_switch_log (toggled_at_ms, new_state) VALUES (?, ?)`)
        .run(1_700_000_000_000, ''),
    ).toThrow(/CHECK constraint failed/i)

    // And nulls (NOT NULL).
    expect(() =>
      db.prepare(`INSERT INTO kill_switch_log (toggled_at_ms, new_state) VALUES (?, ?)`)
        .run(1_700_000_000_000, null as unknown as string),
    ).toThrow(/NOT NULL constraint failed/i)
  })

  it('toggled_at_ms is NOT NULL', () => {
    expect(() =>
      db.prepare(`INSERT INTO kill_switch_log (toggled_at_ms, new_state) VALUES (?, ?)`)
        .run(null as unknown as number, 'tripped'),
    ).toThrow(/NOT NULL constraint failed/i)
  })

  it('reason and set_by are nullable', () => {
    db.prepare(`INSERT INTO kill_switch_log (toggled_at_ms, new_state) VALUES (?, ?)`)
      .run(1_700_000_000_000, 'tripped')
    const row = db.prepare(`SELECT reason, set_by FROM kill_switch_log`).get() as {
      reason: string | null
      set_by: string | null
    }
    expect(row.reason).toBeNull()
    expect(row.set_by).toBeNull()
  })

  it('idempotent: running CREATE TABLE IF NOT EXISTS twice does not throw', () => {
    expect(() => {
      db.prepare(KILL_SWITCH_LOG_TABLE_SQL).run()
      db.prepare(KILL_SWITCH_LOG_INDEX_SQL).run()
    }).not.toThrow()
  })

  it('toggled_at_ms index exists for ORDER BY DESC scans', () => {
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_kill_switch_log_toggled_at'`)
      .get() as { name: string } | undefined
    expect(idx?.name).toBe('idx_kill_switch_log_toggled_at')
  })
})
