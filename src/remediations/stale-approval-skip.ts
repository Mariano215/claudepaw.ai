// src/remediations/stale-approval-skip.ts
//
// Auto-skips paws that have been waiting for human approval longer than
// APPROVAL_STALE_HOURS (default 48). Prevents the "forgot to click approve"
// backlog: the approval card eventually gets lost, the paw stays frozen,
// no new cycles run. After the threshold we treat it as an implicit skip,
// mark the stuck cycle as failed, and return the paw to `active`.
//
// Safety rails:
//   - Only touches cycles whose `started_at` is older than the threshold.
//     Fresh approval requests are never auto-skipped.
//   - The skipped cycle is marked `phase='failed'` with a clear error, not
//     `completed`. That way the daily report surfaces it as a missed human
//     decision, and `paw-retry` won't bounce it (paw-retry looks for cycles
//     that failed within 30 min only).
//   - Paw moves back to `active` with next_run advanced to the normal cron
//     (not immediate), so there's no storm of retries on stuck paws.

import type Database from 'better-sqlite3'
import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { readEnvFile } from '../env.js'
import type { RemediationDefinition, RemediationOutcome } from './types.js'

const REMEDIATION_ID = 'stale-approval-skip'
const DEFAULT_STALE_HOURS = 48

function resolveStaleMs(): number {
  const env = readEnvFile()
  const raw = env.APPROVAL_STALE_HOURS
  const hours = Number(raw)
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_STALE_HOURS * 60 * 60 * 1000
  return Math.round(hours * 60 * 60 * 1000)
}

interface StaleRow {
  paw_id: string
  cycle_id: string
  started_at: number
  cron: string
}

export const staleApprovalSkipRemediation: RemediationDefinition = {
  id: REMEDIATION_ID,
  name: 'Stale approval auto-skip',
  tier: 'auto-safe',
  description:
    'Releases paws stuck in waiting_approval after the configured threshold (default 48h), marking the cycle as skipped and returning the paw to active.',

  async run(ctx): Promise<RemediationOutcome> {
    const db = getDb()
    const staleMs = resolveStaleMs()
    const staleBefore = ctx.now - staleMs

    // Paws currently waiting approval, latest cycle older than threshold,
    // still in the `decide` phase (no operator action yet).
    const rows = db.prepare(`
      WITH latest AS (
        SELECT paw_id, MAX(started_at) AS max_started
          FROM paw_cycles GROUP BY paw_id
      )
      SELECT p.id         AS paw_id,
             c.id         AS cycle_id,
             c.started_at AS started_at,
             p.cron       AS cron
        FROM paws p
        JOIN latest l ON l.paw_id = p.id
        JOIN paw_cycles c ON c.paw_id = p.id AND c.started_at = l.max_started
       WHERE p.status = 'waiting_approval'
         AND c.phase = 'decide'
         AND c.started_at <= ?
    `).all(staleBefore) as StaleRow[]

    if (rows.length === 0) {
      return { acted: false, summary: 'No stale approvals.' }
    }

    const skipped: Array<{ paw_id: string; cycle_id: string; age_hours: number }> = []

    for (const row of rows) {
      const ageHours = Math.round((ctx.now - row.started_at) / (60 * 60 * 1000))

      if (ctx.dryRun) {
        skipped.push({ paw_id: row.paw_id, cycle_id: row.cycle_id, age_hours: ageHours })
        continue
      }

      applySkip(db, row.paw_id, row.cycle_id, ageHours)
      skipped.push({ paw_id: row.paw_id, cycle_id: row.cycle_id, age_hours: ageHours })
      logger.warn(
        { pawId: row.paw_id, cycleId: row.cycle_id, ageHours },
        '[remediations] Auto-skipped stale approval',
      )
    }

    return {
      acted: skipped.length > 0,
      summary: `Auto-skipped ${skipped.length} stale approval(s): ${skipped.map((s) => `${s.paw_id} (${s.age_hours}h)`).join(', ')}`,
      detail: { skipped, threshold_ms: staleMs },
    }
  },
}

function applySkip(
  db: InstanceType<typeof Database>,
  pawId: string,
  cycleId: string,
  ageHours: number,
): void {
  const now = Date.now()
  // Mark the stuck cycle as failed with a clear reason. We deliberately do
  // not set phase='completed' because the ACT/REPORT phases never ran.
  db.prepare(`
    UPDATE paw_cycles
       SET phase = 'failed',
           completed_at = ?,
           error = ?
     WHERE id = ? AND phase = 'decide'
  `).run(
    now,
    `Auto-skipped after ${ageHours}h in waiting_approval (APPROVAL_STALE_HOURS threshold)`,
    cycleId,
  )

  // Return the paw to active. Don't bump next_run here -- the normal cron
  // will catch the next run at its natural time, no retry storm.
  db.prepare(`UPDATE paws SET status = 'active' WHERE id = ? AND status = 'waiting_approval'`).run(pawId)
}
