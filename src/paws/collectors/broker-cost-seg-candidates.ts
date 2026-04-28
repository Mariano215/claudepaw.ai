// src/paws/collectors/broker-cost-seg-candidates.ts
//
// Observe-phase collector for re-cost-seg-candidate-scan.
//
// Eligible: cost_basis (or acquisition_price fallback) >= $300k AND
// status='active' AND no cost_seg_studies row with status IN ('engaged','complete').
//
// OBBB Act (Jan 19 2025) restored 100% bonus depreciation for property
// acquired after that date. Earlier acquisitions are still look-back
// eligible via Form 3115. The OBBB flag is just a date check.
//
// Y1 deduction projection uses the conservative 27% of basis rule of thumb
// for residential under OBBB. ANALYZE can refine; this is a placeholder.

import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'

const BASIS_THRESHOLD = 300_000
const Y1_DEDUCTION_FACTOR = 0.27
const STUDY_COST_LOW = 3_000
const STUDY_COST_HIGH = 5_000
const OBBB_CUTOFF_DATE = '2025-01-19'

interface PropertyRow {
  id: string
  address: string
  cost_basis: number | null
  acquisition_price: number | null
  acquisition_date: string | null
  current_arv: number | null
}

interface StudyRow {
  property_id: string
}

export const brokerCostSegCandidatesCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()

  // ---------------------------------------------------------------------
  // 1. Active properties whose effective basis clears the threshold.
  //    SQLite COALESCE picks cost_basis when present, else acquisition_price.
  // ---------------------------------------------------------------------
  let candidates: PropertyRow[] = []
  try {
    const db = getDb()
    candidates = db.prepare(`
      SELECT id, address, cost_basis, acquisition_price, acquisition_date, current_arv
      FROM properties
      WHERE project_id = ?
        AND status = 'active'
        AND COALESCE(cost_basis, acquisition_price, 0) >= ?
      ORDER BY COALESCE(cost_basis, acquisition_price, 0) DESC
    `).all(ctx.projectId, BASIS_THRESHOLD) as PropertyRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`properties query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-cost-seg-candidates] properties query failed')
  }

  // ---------------------------------------------------------------------
  // 2. Exclude any property that already has an engaged or complete study.
  // ---------------------------------------------------------------------
  const ineligible = new Set<string>()
  if (candidates.length > 0) {
    try {
      const db = getDb()
      const placeholders = candidates.map(() => '?').join(',')
      const rows = db.prepare(`
        SELECT DISTINCT property_id
        FROM cost_seg_studies
        WHERE project_id = ?
          AND status IN ('engaged','complete')
          AND property_id IN (${placeholders})
      `).all(ctx.projectId, ...candidates.map((c) => c.id)) as StudyRow[]
      for (const r of rows) ineligible.add(r.property_id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`cost_seg_studies exclusion query failed: ${msg}`)
      logger.warn({ err, pawId: ctx.pawId }, '[broker-cost-seg-candidates] studies query failed')
    }
  }

  const eligible = candidates
    .filter((p) => !ineligible.has(p.id))
    .map((p) => {
      const costBasis = p.cost_basis
      const acqPrice = p.acquisition_price
      const basis = costBasis ?? acqPrice ?? 0
      const basisSource: 'cost_basis' | 'acquisition_price' =
        costBasis !== null && costBasis !== undefined ? 'cost_basis' : 'acquisition_price'

      // OBBB eligibility: lexicographic compare works for YYYY-MM-DD.
      const obbbEligible = !!p.acquisition_date && p.acquisition_date >= OBBB_CUTOFF_DATE
      const lookBackEligible = !!p.acquisition_date && p.acquisition_date < OBBB_CUTOFF_DATE

      return {
        property_id: p.id,
        address: p.address,
        basis,
        basis_source: basisSource,
        acquisition_date: p.acquisition_date,
        obbb_eligible: obbbEligible,
        look_back_eligible: lookBackEligible,
        current_arv: p.current_arv,
        projected_y1_deduction: Math.round(basis * Y1_DEDUCTION_FACTOR),
        projected_study_cost_low: STUDY_COST_LOW,
        projected_study_cost_high: STUDY_COST_HIGH,
      }
    })

  const raw_data = {
    collected_at_ms: now,
    candidates: eligible,
    total_candidates: eligible.length,
  }

  logger.info(
    {
      pawId: ctx.pawId,
      totalCandidates: eligible.length,
      excluded: ineligible.size,
    },
    '[broker-cost-seg-candidates] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-cost-seg-candidates',
    errors: errors.length ? errors : undefined,
  }
}
