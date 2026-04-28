// src/paws/collectors/broker-pipeline-snapshot.ts
//
// Observe-phase collector for re-deal-pipeline-stale.
//
// Returns a snapshot of every open deal (status NOT IN closed/passed)
// scoped to the broker project, with pre-computed staleness day-counts so
// the ANALYZE LLM can severity-rank without doing date math.
//
// Note on days_in_status: the deals table has no status_changed_at column
// in v1, so we approximate with days_since_update. Documented in the
// returned shape.

import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'

const MS_PER_DAY = 86_400_000

interface DealRow {
  id: string
  address: string
  status: string
  severity: number | null
  list_price: number | null
  deal_type: string | null
  updated_at: number
}

export const brokerPipelineSnapshotCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()

  let deals: DealRow[] = []
  try {
    const db = getDb()
    deals = db.prepare(`
      SELECT id, address, status, severity, list_price, deal_type, updated_at
      FROM deals
      WHERE project_id = ?
        AND status NOT IN ('closed','passed')
      ORDER BY updated_at ASC
    `).all(ctx.projectId) as DealRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`deals query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-pipeline-snapshot] deals query failed')
  }

  const enrichedDeals = deals.map((d) => {
    const daysSinceUpdate = Math.floor((now - d.updated_at) / MS_PER_DAY)
    return {
      id: d.id,
      address: d.address,
      status: d.status as 'sourced' | 'under-review' | 'under-contract' | 'closed' | 'passed',
      severity: d.severity,
      days_since_update: daysSinceUpdate,
      // Approximation: no status_changed_at column in v1.
      days_in_status: daysSinceUpdate,
      list_price: d.list_price,
      deal_type: d.deal_type,
    }
  })

  const raw_data = {
    collected_at_ms: now,
    deals: enrichedDeals,
    total_open: enrichedDeals.length,
  }

  logger.info(
    { pawId: ctx.pawId, totalOpen: enrichedDeals.length },
    '[broker-pipeline-snapshot] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-pipeline-snapshot',
    errors: errors.length ? errors : undefined,
  }
}
