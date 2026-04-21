// src/remediations/db.ts
// Persistence for the remediations log. Bot DB is the source of truth;
// rows are mirrored to the server DB via POST /api/v1/internal/remediations
// so the dashboard can display them on remote deployments.

import type Database from 'better-sqlite3'
import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { DASHBOARD_URL, BOT_API_TOKEN, DASHBOARD_API_TOKEN } from '../config.js'
import type { RemediationLogRow, RemediationOutcome } from './types.js'

/**
 * Create table if it doesn't exist. Safe to call on every bot start.
 */
export function initRemediationsSchema(db: InstanceType<typeof Database> = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remediations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      remediation_id  TEXT    NOT NULL,
      started_at      INTEGER NOT NULL,
      completed_at    INTEGER NOT NULL,
      acted           INTEGER NOT NULL DEFAULT 0,
      summary         TEXT    NOT NULL,
      detail          TEXT,
      errors          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_remediations_started
      ON remediations(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_remediations_id_started
      ON remediations(remediation_id, started_at DESC);
  `)
}

export function logRemediation(
  remediationId: string,
  startedAt: number,
  outcome: RemediationOutcome,
): void {
  const db = getDb()
  const completedAt = Date.now()
  const detailJson = outcome.detail ? JSON.stringify(outcome.detail) : null
  const errorsJson = outcome.errors?.length ? JSON.stringify(outcome.errors) : null

  const info = db.prepare(
    `INSERT INTO remediations (remediation_id, started_at, completed_at, acted, summary, detail, errors)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    remediationId,
    startedAt,
    completedAt,
    outcome.acted ? 1 : 0,
    outcome.summary,
    detailJson,
    errorsJson,
  )

  // Best-effort mirror to server DB so the dashboard can display it.
  // Never throws -- the bot DB write is authoritative and sync is opportunistic.
  syncRemediationToServer({
    remediation_id: remediationId,
    bot_row_id: Number(info.lastInsertRowid),
    started_at: startedAt,
    completed_at: completedAt,
    acted: outcome.acted ? 1 : 0,
    summary: outcome.summary,
    detail: detailJson,
    errors: errorsJson,
  })
}

interface SyncPayload {
  remediation_id: string
  bot_row_id: number
  started_at: number
  completed_at: number
  acted: number
  summary: string
  detail: string | null
  errors: string | null
}

async function syncRemediationToServerAsync(payload: SyncPayload): Promise<void> {
  if (!DASHBOARD_URL) return
  const token = BOT_API_TOKEN || DASHBOARD_API_TOKEN
  if (!token) return
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/v1/internal/remediations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dashboard-token': token,
      },
      body: JSON.stringify({ rows: [payload] }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      logger.debug(
        { status: res.status, remediation: payload.remediation_id },
        '[remediations] server sync non-200',
      )
    }
  } catch (err) {
    logger.debug({ err, remediation: payload.remediation_id }, '[remediations] server sync failed')
  }
}

function syncRemediationToServer(payload: SyncPayload): void {
  // Fire and forget -- no await from the log-write hot path.
  void syncRemediationToServerAsync(payload)
}

/**
 * Fetch the last run for a given remediation. Used to enforce cooldowns
 * between runs so we don't spam retries on the same failing paw.
 */
export function lastRunFor(remediationId: string): RemediationLogRow | null {
  const row = getDb().prepare(
    `SELECT * FROM remediations WHERE remediation_id = ? ORDER BY started_at DESC LIMIT 1`,
  ).get(remediationId) as RemediationLogRow | undefined
  return row ?? null
}

/**
 * For the daily report + dashboard: return remediations that ACTED within the
 * given millisecond window (default 24h). Excludes no-op runs by default so
 * the email doesn't bloat with "checked and found nothing".
 */
export function recentRemediations(
  windowMs: number = 24 * 60 * 60 * 1000,
  includeNoop: boolean = false,
): RemediationLogRow[] {
  const cutoff = Date.now() - windowMs
  const sql = includeNoop
    ? `SELECT * FROM remediations WHERE started_at >= ? ORDER BY started_at DESC`
    : `SELECT * FROM remediations WHERE started_at >= ? AND acted = 1 ORDER BY started_at DESC`
  return getDb().prepare(sql).all(cutoff) as RemediationLogRow[]
}

/**
 * Count how many remediations of a given id ran in a window. Used for
 * fire-prevention ("don't retry the same paw more than 3 times in 24h").
 */
export function countRunsInWindow(
  remediationId: string,
  windowMs: number,
  filter?: (row: RemediationLogRow) => boolean,
): number {
  const cutoff = Date.now() - windowMs
  const rows = getDb().prepare(
    `SELECT * FROM remediations WHERE remediation_id = ? AND started_at >= ?`,
  ).all(remediationId, cutoff) as RemediationLogRow[]
  return filter ? rows.filter(filter).length : rows.length
}
