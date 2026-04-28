// src/paws/collectors/broker-vendor-rollup.ts
//
// Observe-phase collector for re-contractor-vendor-tracker.
//
// Returns a per-contractor scoreboard scoped to the broker project. Scores
// (on_time_pct, budget_variance_pct, callback_rate, last_used_at) are
// maintained manually by the operator in the contractors table for v1.
//
// jobs_count: hardcoded to 0 in v1. The rehab_estimates table has no
// contractor_id column, so we cannot link rehab jobs to a contractor here.
// Tracking will come once a join column is added; until then the
// scoreboard is sufficient to flag laggards.

import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'

const MS_PER_DAY = 86_400_000

interface ContractorRow {
  id: string
  name: string
  trade: string | null
  on_time_pct: number | null
  budget_variance_pct: number | null
  callback_rate: number | null
  last_used_at: string | null
}

function daysSince(dateStr: string | null, nowMs: number): number | null {
  if (!dateStr) return null
  const parsed = Date.parse(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(parsed)) return null
  const todayUtc = Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY
  return Math.floor((todayUtc - parsed) / MS_PER_DAY)
}

export const brokerVendorRollupCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()

  let rows: ContractorRow[] = []
  try {
    const db = getDb()
    rows = db.prepare(`
      SELECT id, name, trade, on_time_pct, budget_variance_pct, callback_rate, last_used_at
      FROM contractors
      WHERE project_id = ?
      ORDER BY (last_used_at IS NULL), last_used_at DESC
    `).all(ctx.projectId) as ContractorRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`contractors query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-vendor-rollup] contractors query failed')
  }

  const contractors = rows.map((c) => ({
    id: c.id,
    name: c.name,
    trade: c.trade,
    on_time_pct: c.on_time_pct,
    budget_variance_pct: c.budget_variance_pct,
    callback_rate: c.callback_rate,
    last_used_at: c.last_used_at,
    days_since_last_used: daysSince(c.last_used_at, now),
    // v1: no contractor_id on rehab_estimates, so jobs are tracked separately.
    jobs_count: 0,
  }))

  const raw_data = {
    collected_at_ms: now,
    contractors,
  }

  logger.info(
    { pawId: ctx.pawId, contractorCount: contractors.length },
    '[broker-vendor-rollup] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-vendor-rollup',
    errors: errors.length ? errors : undefined,
  }
}
