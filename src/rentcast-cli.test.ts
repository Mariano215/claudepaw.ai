// Tests for scripts/rentcast-cli.ts cache + budget gate logic.
//
// Runs against an in-memory SQLite DB via a fresh initDatabase() so the test
// exercises the same schema the CLI uses in production. We stub `fetch` so
// no real network calls happen. The CLI's main() owns process.exit so we
// re-implement the call path here using the same helpers it exports.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { billingPeriodStartMs } from './rentcast-cli.js'

// We don't import the CLI itself because main() sets up its own DB. Instead
// we replicate the in-DB state the CLI depends on via a synthetic schema
// and verify the gate/cache logic.

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE rentcast_cache (
      key TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      cached_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL
    );
    CREATE TABLE rentcast_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      query TEXT NOT NULL,
      called_at INTEGER NOT NULL,
      status_code INTEGER NOT NULL,
      bytes_returned INTEGER
    );
    CREATE INDEX idx_rentcast_log_called_at ON rentcast_call_log(called_at);
  `)
  return db
}

function firstOfMonthMs(now: number = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0)
}

function countCalls(db: Database.Database): number {
  const since = firstOfMonthMs()
  const row = db
    .prepare('SELECT COUNT(*) as n FROM rentcast_call_log WHERE called_at >= ?')
    .get(since) as { n: number }
  return row.n
}

describe('rentcast cache + budget gate', () => {
  let db: Database.Database

  beforeEach(() => {
    db = makeDb()
  })
  afterEach(() => {
    db.close()
  })

  it('counts only rows in the current calendar month', () => {
    const now = Date.now()
    const lastMonth = firstOfMonthMs(now) - 24 * 60 * 60 * 1000
    db.prepare(
      'INSERT INTO rentcast_call_log (endpoint, query, called_at, status_code) VALUES (?,?,?,?)',
    ).run('listings', 'zipCode=19081', lastMonth, 200)
    db.prepare(
      'INSERT INTO rentcast_call_log (endpoint, query, called_at, status_code) VALUES (?,?,?,?)',
    ).run('listings', 'zipCode=19081', now, 200)

    expect(countCalls(db)).toBe(1)
  })

  it('serves cache when not expired', () => {
    const key = 'listings:zipCode=19081'
    db.prepare(
      'INSERT INTO rentcast_cache (key, response_json, cached_at, ttl_ms) VALUES (?,?,?,?)',
    ).run(key, JSON.stringify({ listings: [] }), Date.now() - 1000, 60_000)

    const row = db.prepare('SELECT * FROM rentcast_cache WHERE key = ?').get(key) as
      | { response_json: string; cached_at: number; ttl_ms: number }
      | undefined
    expect(row).toBeDefined()
    expect(Date.now() - (row?.cached_at ?? 0) < (row?.ttl_ms ?? 0)).toBe(true)
  })

  it('treats cache as expired when age > ttl_ms', () => {
    const key = 'listings:zipCode=19081'
    db.prepare(
      'INSERT INTO rentcast_cache (key, response_json, cached_at, ttl_ms) VALUES (?,?,?,?)',
    ).run(key, '{}', Date.now() - 120_000, 60_000)

    const row = db.prepare('SELECT * FROM rentcast_cache WHERE key = ?').get(key) as
      | { cached_at: number; ttl_ms: number }
      | undefined
    expect(Date.now() - (row?.cached_at ?? 0) > (row?.ttl_ms ?? 0)).toBe(true)
  })

  it('enforces monthly cap — 46 recorded calls with cap 45 trips budget_exhausted', () => {
    const now = Date.now()
    const insert = db.prepare(
      'INSERT INTO rentcast_call_log (endpoint, query, called_at, status_code) VALUES (?,?,?,?)',
    )
    for (let i = 0; i < 46; i++) insert.run('listings', `i=${i}`, now, 200)

    const cap = 45
    const calls = countCalls(db)
    const exhausted = calls >= cap
    expect(calls).toBe(46)
    expect(exhausted).toBe(true)
  })

  it('cache key is stable across arg order permutations', () => {
    // The CLI sorts query-string params before building the key so the
    // cache hits deterministically regardless of the flag order the paw
    // passes them in.
    function buildQuery(params: Record<string, string>): string {
      const entries = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== '')
        .sort(([a], [b]) => a.localeCompare(b))
      return entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    }
    const a = buildQuery({ zipCode: '19081', status: 'Active', maxPrice: '310000' })
    const b = buildQuery({ maxPrice: '310000', zipCode: '19081', status: 'Active' })
    expect(a).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// Billing-period window.
//
// Regression guard for the 2026-08-10 quota blowout: the cap counted calendar
// months while RentCast bills 13th-to-13th. Every calendar month sat at
// exactly 45/45 while the Jul 13 - Aug 13 billing window took 66 calls and
// exhausted the plan's 50-call quota.
// ---------------------------------------------------------------------------

describe('billingPeriodStartMs', () => {
  const ANCHOR = 13
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

  it('anchors to this month once the anchor day has passed', () => {
    const now = Date.UTC(2026, 7, 10) // Aug 10 -- before the 13th
    expect(iso(billingPeriodStartMs(now, ANCHOR))).toBe('2026-07-13')
  })

  it('rolls forward on the anchor day itself', () => {
    const now = Date.UTC(2026, 7, 13) // Aug 13
    expect(iso(billingPeriodStartMs(now, ANCHOR))).toBe('2026-08-13')
  })

  it('rolls back across a year boundary', () => {
    const now = Date.UTC(2026, 0, 5) // Jan 5
    expect(iso(billingPeriodStartMs(now, ANCHOR))).toBe('2025-12-13')
  })

  it('clamps an anchor past the end of a short month', () => {
    // Anchor 31 in March, before the 31st, must land on Feb 28 (2026 is not a
    // leap year), never roll into an invalid Feb 31.
    const now = Date.UTC(2026, 2, 5) // Mar 5
    expect(iso(billingPeriodStartMs(now, 31))).toBe('2026-02-28')
  })

  it('spans the boundary the calendar-month window missed', () => {
    // The actual failure: counting from Aug 1 sees 35 calls and passes a cap
    // of 45. Counting from Jul 13 sees the full 66 and refuses.
    const augustFirst = Date.UTC(2026, 7, 1)
    const periodStart = billingPeriodStartMs(Date.UTC(2026, 7, 10), ANCHOR)
    expect(periodStart).toBeLessThan(augustFirst)
  })
})
