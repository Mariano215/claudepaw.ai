// src/paws/collectors/broker-equity-snapshot.ts
//
// Observe-phase collector for re-refi-monitor.
//
// Per-property equity snapshot: ARV, last loan balance, LTV, seasoning,
// last refi date, and a "in_refi_window" flag (BRRRR refi gates at
// seasoning >= 6 months AND LTV >= 75%).
//
// v1 simplification on last_loan_balance: the financing_events ledger
// can hold purchase, heloc, refi, payoff, etc. Computing a true running
// balance requires amortization + payoff event aggregation. For v1 we
// take the loan_amount of the most recent event whose type funds a loan
// (purchase | refi | dscr_loan | hard_money) and whose loan_amount IS
// NOT NULL. This is conservative for refi-window detection: a refi we
// haven't logged yet will show stale (older) balance, not stale flat.

import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'

const MS_PER_DAY = 86_400_000
const MS_PER_MONTH = MS_PER_DAY * 30 // approximation; close enough for seasoning
const SEASONING_THRESHOLD_MONTHS = 6
const REFI_LTV_THRESHOLD = 0.75

interface PropertyRow {
  id: string
  address: string
  current_arv: number | null
  brrrr_phase: string | null
  acquisition_date: string | null
}

interface LoanRow {
  loan_amount: number | null
  closing_date: string | null
}

interface RefiRow {
  closing_date: string | null
}

// Months between a YYYY-MM-DD anchor and now (UTC). Negative if anchor is
// in the future (returns 0 in that case for sanity).
function monthsSince(dateStr: string | null, nowMs: number): number | null {
  if (!dateStr) return null
  const parsed = Date.parse(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(parsed)) return null
  const months = (nowMs - parsed) / MS_PER_MONTH
  return months < 0 ? 0 : Math.round(months)
}

export const brokerEquitySnapshotCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()

  // ---------------------------------------------------------------------
  // 1. All active properties.
  // ---------------------------------------------------------------------
  let properties: PropertyRow[] = []
  try {
    const db = getDb()
    properties = db.prepare(`
      SELECT id, address, current_arv, brrrr_phase, acquisition_date
      FROM properties
      WHERE project_id = ?
        AND status = 'active'
      ORDER BY address ASC
    `).all(ctx.projectId) as PropertyRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`properties query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-equity-snapshot] properties query failed')
  }

  // ---------------------------------------------------------------------
  // 2. Per-property: latest loan-funding event + latest refi event.
  //    Two small queries per property keeps the SQL readable and works
  //    fine for portfolio sizes we expect (<200 doors).
  // ---------------------------------------------------------------------
  const enriched = properties.map((p) => {
    let lastLoanBalance: number | null = null
    let lastLoanClosingDate: string | null = null
    let lastRefiDate: string | null = null

    try {
      const db = getDb()
      const loanRow = db.prepare(`
        SELECT loan_amount, closing_date
        FROM financing_events
        WHERE project_id = ?
          AND property_id = ?
          AND event_type IN ('purchase','refi','dscr_loan','hard_money')
          AND loan_amount IS NOT NULL
        ORDER BY (closing_date IS NULL), closing_date DESC, created_at DESC
        LIMIT 1
      `).get(ctx.projectId, p.id) as LoanRow | undefined
      if (loanRow) {
        lastLoanBalance = loanRow.loan_amount
        lastLoanClosingDate = loanRow.closing_date
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`loan lookup failed for ${p.id}: ${msg}`)
      logger.warn({ err, pawId: ctx.pawId, propertyId: p.id }, '[broker-equity-snapshot] loan lookup failed')
    }

    try {
      const db = getDb()
      const refiRow = db.prepare(`
        SELECT closing_date
        FROM financing_events
        WHERE project_id = ?
          AND property_id = ?
          AND event_type = 'refi'
        ORDER BY (closing_date IS NULL), closing_date DESC, created_at DESC
        LIMIT 1
      `).get(ctx.projectId, p.id) as RefiRow | undefined
      lastRefiDate = refiRow?.closing_date ?? null
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`refi lookup failed for ${p.id}: ${msg}`)
      logger.warn({ err, pawId: ctx.pawId, propertyId: p.id }, '[broker-equity-snapshot] refi lookup failed')
    }

    // LTV
    let ltv: number | null = null
    if (lastLoanBalance !== null && p.current_arv !== null && p.current_arv > 0) {
      ltv = lastLoanBalance / p.current_arv
    }

    // Seasoning anchor: last financing closing_date else acquisition_date.
    const seasoningAnchor = lastLoanClosingDate ?? p.acquisition_date
    const seasoningMonths = monthsSince(seasoningAnchor, now)

    const inRefiWindow =
      seasoningMonths !== null &&
      seasoningMonths >= SEASONING_THRESHOLD_MONTHS &&
      ltv !== null &&
      ltv >= REFI_LTV_THRESHOLD

    return {
      property_id: p.id,
      address: p.address,
      current_arv: p.current_arv,
      last_loan_balance: lastLoanBalance,
      ltv,
      brrrr_phase: p.brrrr_phase,
      seasoning_months: seasoningMonths,
      last_refi_date: lastRefiDate,
      in_refi_window: inRefiWindow,
    }
  })

  const raw_data = {
    collected_at_ms: now,
    properties: enriched,
  }

  logger.info(
    {
      pawId: ctx.pawId,
      propertyCount: enriched.length,
      inRefiWindow: enriched.filter((e) => e.in_refi_window).length,
    },
    '[broker-equity-snapshot] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-equity-snapshot',
    errors: errors.length ? errors : undefined,
  }
}
