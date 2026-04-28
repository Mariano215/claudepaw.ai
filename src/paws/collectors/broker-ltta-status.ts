// src/paws/collectors/broker-ltta-status.ts
//
// Observe-phase collector for re-philly-ltta-renewal.
//
// Selects every Philly property (zip 191xx OR county='Philadelphia') and
// LEFT JOINs its tax_abatements row. Computes days_until_recert and
// days_until_end so the ANALYZE LLM can severity-rank without date math.
//
// Why LEFT JOIN: a Philly property without an abatement record is itself
// noteworthy (potential gap to investigate). has_abatement flag tells
// ANALYZE which is which.

import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'

const MS_PER_DAY = 86_400_000

interface JoinedRow {
  property_id: string
  address: string
  county: string | null
  abatement_id: string | null
  abatement_program: string | null
  frozen_assessment: number | null
  current_assessment: number | null
  annual_savings: number | null
  end_date: string | null
  recert_due: string | null
}

// Diff a YYYY-MM-DD date string against today (UTC midnight). Negative = past.
function daysUntil(dateStr: string | null, nowMs: number): number | null {
  if (!dateStr) return null
  const parsed = Date.parse(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(parsed)) return null
  const todayUtc = Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY
  return Math.floor((parsed - todayUtc) / MS_PER_DAY)
}

export const brokerLttaStatusCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()

  // ---------------------------------------------------------------------
  // Philly property + abatement join. We want all Philly properties even
  // if they have no abatement row yet -- LEFT JOIN gives that.
  // ---------------------------------------------------------------------
  let rows: JoinedRow[] = []
  try {
    const db = getDb()
    rows = db.prepare(`
      SELECT
        p.id                   AS property_id,
        p.address              AS address,
        p.county               AS county,
        a.id                   AS abatement_id,
        a.abatement_program    AS abatement_program,
        a.frozen_assessment    AS frozen_assessment,
        a.current_assessment   AS current_assessment,
        a.annual_savings       AS annual_savings,
        a.end_date             AS end_date,
        a.recert_due           AS recert_due
      FROM properties p
      LEFT JOIN tax_abatements a
        ON a.project_id = p.project_id
       AND a.property_id = p.id
      WHERE p.project_id = ?
        AND (p.zip LIKE '191%' OR p.county = 'Philadelphia')
        AND p.status = 'active'
      ORDER BY (a.recert_due IS NULL), a.recert_due ASC, p.address ASC
    `).all(ctx.projectId) as JoinedRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`philly join query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-ltta-status] join query failed')
  }

  const properties = rows.map((r) => ({
    property_id: r.property_id,
    address: r.address,
    county: r.county,
    abatement_program: r.abatement_program,
    frozen_assessment: r.frozen_assessment,
    current_assessment: r.current_assessment,
    annual_savings: r.annual_savings,
    end_date: r.end_date,
    recert_due: r.recert_due,
    days_until_recert: daysUntil(r.recert_due, now),
    days_until_end: daysUntil(r.end_date, now),
    has_abatement: r.abatement_id !== null,
  }))

  const raw_data = {
    collected_at_ms: now,
    properties,
  }

  logger.info(
    {
      pawId: ctx.pawId,
      phillyProperties: properties.length,
      withAbatement: properties.filter((p) => p.has_abatement).length,
    },
    '[broker-ltta-status] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-ltta-status',
    errors: errors.length ? errors : undefined,
  }
}
