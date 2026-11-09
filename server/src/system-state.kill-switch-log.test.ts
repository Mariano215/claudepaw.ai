/**
 * system-state.kill-switch-log.test.ts -- Phase 5 Task 3
 *
 * Unit tests for `appendKillSwitchLog` and `readKillSwitchLog`. The helpers
 * accept a Database handle so the test does not need to mock getServerDb;
 * we hand in a fresh in-memory DB per test.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { appendKillSwitchLog, pruneKillSwitchLog, readKillSwitchLog } from './system-state.js'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.prepare(`
    CREATE TABLE IF NOT EXISTS kill_switch_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      toggled_at_ms  INTEGER NOT NULL,
      new_state      TEXT NOT NULL CHECK (new_state IN ('tripped', 'active')),
      reason         TEXT,
      set_by         TEXT
    )
  `).run()
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_kill_switch_log_toggled_at ON kill_switch_log(toggled_at_ms DESC)
  `).run()
  return db
}

describe('appendKillSwitchLog', () => {
  let db: Database.Database
  beforeEach(() => { db = makeDb() })

  it('inserts a row visible via direct SELECT', () => {
    appendKillSwitchLog(db, {
      toggled_at_ms: 1_700_000_001_000,
      new_state: 'tripped',
      reason: 'spike',
      set_by: 'admin',
    })
    const row = db.prepare(`SELECT toggled_at_ms, new_state, reason, set_by FROM kill_switch_log`).get() as {
      toggled_at_ms: number
      new_state: string
      reason: string | null
      set_by: string | null
    }
    expect(row.toggled_at_ms).toBe(1_700_000_001_000)
    expect(row.new_state).toBe('tripped')
    expect(row.reason).toBe('spike')
    expect(row.set_by).toBe('admin')
  })

  it('returns void (undefined)', () => {
    const result = appendKillSwitchLog(db, {
      toggled_at_ms: 1_700_000_002_000,
      new_state: 'active',
    })
    expect(result).toBeUndefined()
  })

  it('reason and set_by default to null when omitted', () => {
    appendKillSwitchLog(db, {
      toggled_at_ms: 1_700_000_003_000,
      new_state: 'tripped',
    })
    const row = db.prepare(`SELECT reason, set_by FROM kill_switch_log`).get() as {
      reason: string | null
      set_by: string | null
    }
    expect(row.reason).toBeNull()
    expect(row.set_by).toBeNull()
  })

  it('rejects an invalid new_state via the CHECK constraint', () => {
    expect(() => {
      appendKillSwitchLog(db, {
        toggled_at_ms: 1_700_000_000_000,
        // deliberately wrong value -- runtime CHECK should refuse this.
        new_state: 'paused' as unknown as 'tripped',
      })
    }).toThrow(/CHECK constraint failed/i)
  })
})

describe('readKillSwitchLog', () => {
  let db: Database.Database
  beforeEach(() => { db = makeDb() })

  function seed(rows: Array<{ ts: number; state: 'tripped' | 'active'; reason?: string | null; by?: string | null }>) {
    for (const r of rows) {
      appendKillSwitchLog(db, {
        toggled_at_ms: r.ts,
        new_state: r.state,
        reason: r.reason ?? null,
        set_by: r.by ?? null,
      })
    }
  }

  it('returns entries in DESC order of toggled_at_ms', () => {
    seed([
      { ts: 1_700_000_001_000, state: 'tripped', reason: 'first' },
      { ts: 1_700_000_003_000, state: 'tripped', reason: 'third' },
      { ts: 1_700_000_002_000, state: 'active',  reason: 'second' },
    ])
    const out = readKillSwitchLog(db, {})
    expect(out.length).toBe(3)
    expect(out.map(r => r.toggled_at_ms)).toEqual([
      1_700_000_003_000,
      1_700_000_002_000,
      1_700_000_001_000,
    ])
    expect(out[0].new_state).toBe('tripped')
    expect(out[1].new_state).toBe('active')
  })

  it('respects since_ms (entries older than since_ms are excluded)', () => {
    seed([
      { ts: 1_700_000_001_000, state: 'tripped', reason: 'a' },
      { ts: 1_700_000_002_000, state: 'active',  reason: 'b' },
      { ts: 1_700_000_003_000, state: 'tripped', reason: 'c' },
    ])
    const out = readKillSwitchLog(db, { since_ms: 1_700_000_002_000 })
    expect(out.map(r => r.toggled_at_ms)).toEqual([1_700_000_003_000, 1_700_000_002_000])
  })

  it('respects until_ms (entries newer than until_ms are excluded)', () => {
    seed([
      { ts: 1_700_000_001_000, state: 'tripped' },
      { ts: 1_700_000_002_000, state: 'active'  },
      { ts: 1_700_000_003_000, state: 'tripped' },
    ])
    const out = readKillSwitchLog(db, { until_ms: 1_700_000_002_000 })
    expect(out.map(r => r.toggled_at_ms)).toEqual([1_700_000_002_000, 1_700_000_001_000])
  })

  it('respects limit (N+1 seeded, N returned)', () => {
    const seeds: Array<{ ts: number; state: 'tripped' | 'active' }> = []
    for (let i = 0; i < 6; i++) {
      seeds.push({ ts: 1_700_000_000_000 + i * 1000, state: i % 2 === 0 ? 'tripped' : 'active' })
    }
    seed(seeds)
    const out = readKillSwitchLog(db, { limit: 5 })
    expect(out.length).toBe(5)
    // Newest first.
    expect(out[0].toggled_at_ms).toBe(1_700_000_000_000 + 5 * 1000)
  })

  it('returns [] when no entries match the window', () => {
    seed([
      { ts: 1_700_000_001_000, state: 'tripped' },
    ])
    const out = readKillSwitchLog(db, { since_ms: 1_700_000_010_000 })
    expect(out).toEqual([])
  })

  it('returns [] when the table is empty', () => {
    expect(readKillSwitchLog(db, {})).toEqual([])
  })

  it('default limit is 500 (caller passes nothing)', () => {
    const seeds: Array<{ ts: number; state: 'tripped' | 'active' }> = []
    for (let i = 0; i < 600; i++) {
      seeds.push({ ts: 1_700_000_000_000 + i, state: i % 2 === 0 ? 'tripped' : 'active' })
    }
    seed(seeds)
    const out = readKillSwitchLog(db, {})
    expect(out.length).toBe(500)
  })

  it('combined since_ms and until_ms filter (inclusive on both ends)', () => {
    seed([
      { ts: 1_700_000_001_000, state: 'tripped' },
      { ts: 1_700_000_002_000, state: 'active'  },
      { ts: 1_700_000_003_000, state: 'tripped' },
      { ts: 1_700_000_004_000, state: 'active'  },
    ])
    const out = readKillSwitchLog(db, { since_ms: 1_700_000_002_000, until_ms: 1_700_000_003_000 })
    expect(out.map(r => r.toggled_at_ms)).toEqual([1_700_000_003_000, 1_700_000_002_000])
  })
})

// ---------------------------------------------------------------------------
// Phase 6 Task 5 -- pruneKillSwitchLog retention helper
// ---------------------------------------------------------------------------

describe('pruneKillSwitchLog (Phase 6 Task 5)', () => {
  let db: Database.Database
  beforeEach(() => { db = makeDb() })

  function seed(rows: Array<{ ts: number; state: 'tripped' | 'active' }>) {
    for (const r of rows) {
      appendKillSwitchLog(db, { toggled_at_ms: r.ts, new_state: r.state })
    }
  }

  it('is a no-op on an empty table and returns 0', () => {
    const deleted = pruneKillSwitchLog(db, 1_700_000_000_000)
    expect(deleted).toBe(0)
    expect(readKillSwitchLog(db, {})).toEqual([])
  })

  it('deletes rows strictly older than the cutoff', () => {
    seed([
      { ts: 1_000_000_000_000, state: 'tripped' },
      { ts: 1_200_000_000_000, state: 'active'  },
      { ts: 1_700_000_000_000, state: 'tripped' },
    ])
    const cutoffMs = 1_500_000_000_000
    const deleted = pruneKillSwitchLog(db, cutoffMs)
    expect(deleted).toBe(2)
    const remaining = readKillSwitchLog(db, {})
    expect(remaining.length).toBe(1)
    expect(remaining[0].toggled_at_ms).toBe(1_700_000_000_000)
  })

  it('keeps rows exactly at the cutoff (strict less-than semantics)', () => {
    seed([
      { ts: 1_699_999_999_999, state: 'tripped' }, // older than cutoff
      { ts: 1_700_000_000_000, state: 'active'  }, // exactly at cutoff -- keep
      { ts: 1_700_000_000_001, state: 'tripped' }, // newer than cutoff -- keep
    ])
    const cutoffMs = 1_700_000_000_000
    const deleted = pruneKillSwitchLog(db, cutoffMs)
    expect(deleted).toBe(1)
    const remaining = readKillSwitchLog(db, {})
    expect(remaining.map(r => r.toggled_at_ms).sort()).toEqual([
      1_700_000_000_000,
      1_700_000_000_001,
    ])
  })

  it('returns the count of rows deleted', () => {
    // Five rows below the cutoff, two above. Only the below should go.
    // Use a far-future until_ms on the read so the default
    // until_ms=Date.now() does not mask the rows after the cutoff.
    seed([
      { ts: 1_000_000_000_000, state: 'tripped' },
      { ts: 1_100_000_000_000, state: 'active'  },
      { ts: 1_200_000_000_000, state: 'tripped' },
      { ts: 1_300_000_000_000, state: 'active'  },
      { ts: 1_400_000_000_000, state: 'tripped' },
      { ts: 1_800_000_000_000, state: 'active'  },
      { ts: 1_900_000_000_000, state: 'tripped' },
    ])
    const deleted = pruneKillSwitchLog(db, 1_500_000_000_000)
    expect(deleted).toBe(5)
    const remaining = readKillSwitchLog(db, { until_ms: 2_000_000_000_000 })
    expect(remaining.length).toBe(2)
  })
})
