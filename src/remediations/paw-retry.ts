// src/remediations/paw-retry.ts
//
// Auto-retries a paw whose most recent cycle failed. Runs every 5 min.
// Safety rails:
//   - Only retries paws currently in status=active (not paused / waiting_approval)
//   - Only retries cycles that failed in the last 30 min (no ancient retries)
//   - Must wait 10+ min after failure before retrying
//   - No more than 3 retries per paw per 24h
//   - Advances next_run to now so the scheduler picks it up on the next tick
//
// This is auto-safe: bumping next_run is reversible and cheap.

import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { countRunsInWindow } from './db.js'
import type { RemediationDefinition, RemediationOutcome } from './types.js'

const REMEDIATION_ID = 'paw-retry'
const FAILURE_WINDOW_MS = 30 * 60 * 1000 // only retry recent failures
const RETRY_DELAY_MS = 10 * 60 * 1000    // wait 10 min after failure
const MAX_RETRIES_24H = 3                 // per paw
const NON_RETRYABLE_ERROR_PATTERNS = [
  /approval timeout/i,
  /auto-skipped after/i,
  /agent returned no text/i,
  /require is not defined/i,
  /kill switch/i,
  /cost cap/i,
  /refused to run/i,
]

interface FailedCycleRow {
  cycle_id: string
  paw_id: string
  paw_status: string
  completed_at: number
  error: string | null
  next_run: number
}

function isRetryableError(error: string | null): boolean {
  if (!error?.trim()) return true
  return !NON_RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(error))
}

export const pawRetryRemediation: RemediationDefinition = {
  id: REMEDIATION_ID,
  name: 'Paw cycle auto-retry',
  tier: 'auto-safe',
  description: 'Re-fires a paw whose last cycle failed, up to 3 times in 24h, 10 minutes apart.',

  async run(ctx): Promise<RemediationOutcome> {
    const db = getDb()
    const now = ctx.now
    const windowStart = now - FAILURE_WINDOW_MS
    const retryFloor = now - RETRY_DELAY_MS

    // Candidates: most recent cycle per active paw, where that cycle failed.
    const rows = db.prepare(`
      WITH latest AS (
        SELECT paw_id, MAX(started_at) AS max_started
          FROM paw_cycles GROUP BY paw_id
      )
      SELECT c.id AS cycle_id,
             c.paw_id,
             p.status AS paw_status,
             c.completed_at AS completed_at,
             c.error AS error,
             p.next_run AS next_run
        FROM paw_cycles c
        JOIN latest l ON l.paw_id = c.paw_id AND l.max_started = c.started_at
        JOIN paws p    ON p.id = c.paw_id
       WHERE c.phase = 'failed'
         AND c.completed_at IS NOT NULL
         AND c.completed_at >= ?
         AND c.completed_at <= ?
         AND p.status = 'active'
       ORDER BY c.completed_at DESC
    `).all(windowStart, retryFloor) as FailedCycleRow[]

    if (rows.length === 0) {
      return { acted: false, summary: 'No failed paws eligible for retry.' }
    }

    const retried: Array<{ paw_id: string; cycle_id: string; error: string | null }> = []
    const skipped: Array<{ paw_id: string; reason: string }> = []

    for (const row of rows) {
      if (!isRetryableError(row.error)) {
        skipped.push({ paw_id: row.paw_id, reason: `non-retryable error: ${row.error}` })
        continue
      }

      // Per-paw rate limit: count prior runs where WE retried THIS paw in 24h.
      // We look at the full `retried` array in each prior log entry to catch
      // cases where a multi-retry run touched the same paw.
      const priorCount = countRunsInWindow(
        REMEDIATION_ID,
        24 * 60 * 60 * 1000,
        (logRow) => {
          if (!logRow.detail) return false
          try {
            const d = JSON.parse(logRow.detail) as { retried?: Array<{ paw_id: string }> }
            return Boolean(d.retried?.some((r) => r.paw_id === row.paw_id))
          } catch {
            return false
          }
        },
      )
      if (priorCount >= MAX_RETRIES_24H) {
        skipped.push({ paw_id: row.paw_id, reason: `hit ${MAX_RETRIES_24H}/24h retry cap` })
        continue
      }

      if (ctx.dryRun) {
        retried.push({ paw_id: row.paw_id, cycle_id: row.cycle_id, error: row.error })
        continue
      }

      // Bump next_run to now so the scheduler picks it up on the next tick.
      // We leave status='active' -- if it was waiting_approval the query would
      // have excluded it above.
      db.prepare(`UPDATE paws SET next_run = ? WHERE id = ?`).run(now, row.paw_id)
      retried.push({ paw_id: row.paw_id, cycle_id: row.cycle_id, error: row.error })
      logger.info({ pawId: row.paw_id, failedCycleId: row.cycle_id }, '[remediations] Retried failed paw')
    }

    if (retried.length === 0 && skipped.length === 0) {
      return { acted: false, summary: 'No failed paws eligible for retry.' }
    }

    const parts: string[] = []
    if (retried.length > 0) parts.push(`Retried ${retried.length}: ${retried.map(r => r.paw_id).join(', ')}`)
    if (skipped.length > 0) parts.push(`Skipped ${skipped.length} (rate limit)`)

    return {
      acted: retried.length > 0,
      summary: parts.join(' • '),
      detail: {
        retried,
        skipped,
      },
    }
  },
}
