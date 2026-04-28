// src/paws/collectors/broker-assessment-pull.ts
//
// Observe-phase collector for re-property-tax-appeal.
//
// For every owned Philly + Delco property, compare current_assessment to
// estimated market value to flag appeal candidates (>=110% overassessed).
//
// v1 data wiring:
//   - current_assessment: pulled from tax_abatements.current_assessment
//     (latest row per property by recert_due then end_date). If no
//     tax_abatements row exists, this is null and an entry is pushed to
//     errors[] for that property.
//   - est_market_value: median of comps.sold_price keyed first on
//     subject_address, then falling back to zip-level median if no
//     subject-specific comps exist. If neither, falls back to
//     properties.current_arv. If all three are null, est_market_value is
//     null and the row is non-actionable.
//
// v2 follow-up: wire an OPA (Office of Property Assessment) scraper to
// enrich `current_assessment` directly so we are not dependent on the
// tax_abatements ledger being populated. The collector signature already
// supports adding more fields without breaking the paw analyze prompt.

import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'

const APPEAL_CANDIDATE_THRESHOLD = 0.10 // 10% over market

interface PropertyRow {
  id: string
  address: string
  county: string | null
  zip: string | null
  current_arv: number | null
}

interface AbatementRow {
  current_assessment: number | null
}

interface CompRow {
  sold_price: number | null
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

export const brokerAssessmentPullCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()

  let properties: PropertyRow[] = []
  try {
    const db = getDb()
    properties = db.prepare(`
      SELECT id, address, county, zip, current_arv
      FROM properties
      WHERE project_id = ?
        AND status = 'active'
        AND (
          county IN ('Philadelphia','Delaware')
          OR zip LIKE '191%'
          OR zip LIKE '190%'
        )
      ORDER BY address ASC
    `).all(ctx.projectId) as PropertyRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`properties query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-assessment-pull] properties query failed')
  }

  const out: Array<{
    property_id: string
    address: string
    county: string | null
    zip: string | null
    current_assessment: number | null
    comp_median_sold: number | null
    comp_count: number
    est_market_value: number | null
    overassessed_pct: number | null
    appeal_candidate: boolean
  }> = []

  for (const p of properties) {
    let currentAssessment: number | null = null
    let compMedianSold: number | null = null
    let compCount = 0

    // ----- current_assessment from tax_abatements ------------------------
    try {
      const db = getDb()
      const row = db.prepare(`
        SELECT current_assessment
        FROM tax_abatements
        WHERE project_id = ?
          AND property_id = ?
          AND current_assessment IS NOT NULL
        ORDER BY (recert_due IS NULL), recert_due DESC, (end_date IS NULL), end_date DESC, created_at DESC
        LIMIT 1
      `).get(ctx.projectId, p.id) as AbatementRow | undefined
      currentAssessment = row?.current_assessment ?? null
      if (currentAssessment === null) {
        errors.push(`${p.id}: no tax_abatements.current_assessment logged (v2 will pull from OPA)`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`tax_abatements query failed for ${p.id}: ${msg}`)
      logger.warn({ err, pawId: ctx.pawId, propertyId: p.id }, '[broker-assessment-pull] abatements query failed')
    }

    // ----- subject-address comps first -----------------------------------
    let comps: CompRow[] = []
    try {
      const db = getDb()
      comps = db.prepare(`
        SELECT sold_price
        FROM comps
        WHERE project_id = ?
          AND subject_address = ?
          AND sold_price IS NOT NULL
      `).all(ctx.projectId, p.address) as CompRow[]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`comps query (subject) failed for ${p.id}: ${msg}`)
      logger.warn({ err, pawId: ctx.pawId, propertyId: p.id }, '[broker-assessment-pull] comps query (subject) failed')
    }

    // ----- fallback: zip-level comps -------------------------------------
    if (comps.length === 0 && p.zip) {
      try {
        const db = getDb()
        comps = db.prepare(`
          SELECT c.sold_price
          FROM comps c
          JOIN properties subj ON subj.address = c.subject_address AND subj.project_id = c.project_id
          WHERE c.project_id = ?
            AND c.sold_price IS NOT NULL
            AND subj.zip = ?
        `).all(ctx.projectId, p.zip) as CompRow[]
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`comps query (zip-fallback) failed for ${p.id}: ${msg}`)
        logger.warn({ err, pawId: ctx.pawId, propertyId: p.id }, '[broker-assessment-pull] comps query (zip-fallback) failed')
      }
    }

    compCount = comps.length
    const soldPrices = comps
      .map((c) => c.sold_price)
      .filter((v): v is number => typeof v === 'number')
    compMedianSold = median(soldPrices)

    if (compCount === 0) {
      errors.push(`${p.id}: no comps logged (subject or zip-level) -- est_market_value falls back to current_arv`)
    }

    const estMarketValue = compMedianSold ?? p.current_arv

    let overassessedPct: number | null = null
    if (currentAssessment !== null && estMarketValue !== null && estMarketValue > 0) {
      overassessedPct = currentAssessment / estMarketValue - 1
    }
    const appealCandidate = overassessedPct !== null && overassessedPct >= APPEAL_CANDIDATE_THRESHOLD

    out.push({
      property_id: p.id,
      address: p.address,
      county: p.county,
      zip: p.zip,
      current_assessment: currentAssessment,
      comp_median_sold: compMedianSold,
      comp_count: compCount,
      est_market_value: estMarketValue,
      overassessed_pct: overassessedPct,
      appeal_candidate: appealCandidate,
    })
  }

  const raw_data = {
    collected_at_ms: now,
    properties: out,
  }

  logger.info(
    {
      pawId: ctx.pawId,
      propertyCount: out.length,
      appealCandidates: out.filter((p) => p.appeal_candidate).length,
    },
    '[broker-assessment-pull] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-assessment-pull',
    errors: errors.length ? errors : undefined,
  }
}
