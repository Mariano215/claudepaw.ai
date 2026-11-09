import type Database from 'better-sqlite3'
import { getServerDb } from './db.js'

export interface KillSwitch {
  set_at: number
  reason: string
  set_by: string | null
}

/**
 * One row in the append-only kill_switch_log table.
 *
 * The table records every operator-initiated transition of the global
 * kill switch (POST -> 'tripped', DELETE -> 'active'). The current
 * singleton state still lives in `system_state`; the log exists so the
 * weekly report can surface intra-week toggle counts and the latest
 * transition reason without needing a real history join.
 */
export interface KillSwitchLogEntry {
  id: number
  toggled_at_ms: number
  new_state: 'tripped' | 'active'
  reason: string | null
  set_by: string | null
}

interface SystemStateRow {
  id: number
  kill_switch_at: number | null
  kill_switch_reason: string | null
  kill_switch_set_by: string | null
  updated_at: number
}

/** Returns the active kill-switch record, or null if no kill-switch is set. */
export function getKillSwitch(): KillSwitch | null {
  const row = getServerDb()
    .prepare('SELECT kill_switch_at, kill_switch_reason, kill_switch_set_by FROM system_state WHERE id = 1')
    .get() as Pick<SystemStateRow, 'kill_switch_at' | 'kill_switch_reason' | 'kill_switch_set_by'> | undefined

  if (!row || row.kill_switch_at === null) return null

  return {
    set_at: row.kill_switch_at,
    reason: row.kill_switch_reason ?? '',
    set_by: row.kill_switch_set_by ?? null,
  }
}

/** Activates the kill-switch with a reason and the identity of who set it. */
export function setKillSwitch(reason: string, setBy: string): void {
  const now = Date.now()
  const result = getServerDb()
    .prepare(
      'UPDATE system_state SET kill_switch_at = ?, kill_switch_reason = ?, kill_switch_set_by = ?, updated_at = ? WHERE id = 1'
    )
    .run(now, reason, setBy, now)
  if (result.changes === 0) {
    throw new Error('system_state singleton row missing - DB not initialized')
  }
}

/** Clears the kill-switch, returning the system to normal operation. */
export function clearKillSwitch(): void {
  const now = Date.now()
  const result = getServerDb()
    .prepare(
      'UPDATE system_state SET kill_switch_at = NULL, kill_switch_reason = NULL, kill_switch_set_by = NULL, updated_at = ? WHERE id = 1'
    )
    .run(now)
  if (result.changes === 0) {
    throw new Error('system_state singleton row missing - DB not initialized')
  }
}

// ---------------------------------------------------------------------------
// kill_switch_log -- append-only history of toggles (Phase 5 Task 3).
// ---------------------------------------------------------------------------

/**
 * Upper bound on kill_switch_log reads. Doubles as:
 *   - the default `limit` for {@link readKillSwitchLog} when the caller
 *     does not supply one (the DB-layer default), and
 *   - the route-level cap the HTTP handlers clamp `?limit=` against
 *     (imported by sub-modules that expose the log).
 *
 * One export, one number: if 500 stops being the right ceiling the DB
 * default and the route cap move together.
 */
export const KILL_SWITCH_LOG_LIMIT = 500

/**
 * Append one transition to `kill_switch_log`. Caller supplies the
 * timestamp so the log entry stays in lockstep with the `system_state`
 * UPDATE (both come from the same `Date.now()` reading).
 *
 * The DB is passed in (not pulled from `getServerDb`) so the route
 * handlers and the weekly report can hand in the same handle they
 * already hold and so tests can exercise this against an in-memory DB
 * without mocking the singleton accessor.
 */
export function appendKillSwitchLog(
  db: Database.Database,
  entry: {
    toggled_at_ms: number
    new_state: 'tripped' | 'active'
    reason?: string | null
    set_by?: string | null
  },
): void {
  db.prepare(
    `INSERT INTO kill_switch_log (toggled_at_ms, new_state, reason, set_by)
     VALUES (?, ?, ?, ?)`,
  ).run(
    entry.toggled_at_ms,
    entry.new_state,
    entry.reason ?? null,
    entry.set_by ?? null,
  )
}

/**
 * Read entries from `kill_switch_log`, newest first, optionally bounded
 * by a [since_ms, until_ms] window. Both bounds are inclusive so the
 * weekly report can pass `weekStartMs` / `weekEndMs` directly. Default
 * window is "all of history up to now" with a 500-row safety cap so a
 * runaway operator cannot blow the page size.
 */
export function readKillSwitchLog(
  db: Database.Database,
  opts: { since_ms?: number; until_ms?: number; limit?: number },
): KillSwitchLogEntry[] {
  const sinceMs = opts.since_ms ?? 0
  const untilMs = opts.until_ms ?? Date.now()
  const limit = opts.limit ?? KILL_SWITCH_LOG_LIMIT
  return db.prepare(
    `SELECT id, toggled_at_ms, new_state, reason, set_by
     FROM kill_switch_log
     WHERE toggled_at_ms >= ? AND toggled_at_ms <= ?
     ORDER BY toggled_at_ms DESC
     LIMIT ?`,
  ).all(sinceMs, untilMs, limit) as KillSwitchLogEntry[]
}

/**
 * Phase 6 Task 5 -- retention pruning.
 *
 * Delete rows whose `toggled_at_ms` is strictly less than the cutoff.
 * Returns the number of rows removed so the caller can log how many
 * went. Compared to the other kill-switch helpers this is pure: no
 * timestamp of its own, caller passes in the cutoff computed from
 * `Date.now() - N * 86_400_000`.
 */
export function pruneKillSwitchLog(
  db: Database.Database,
  cutoffMs: number,
): number {
  const result = db.prepare(
    `DELETE FROM kill_switch_log WHERE toggled_at_ms < ?`,
  ).run(cutoffMs)
  return result.changes
}
