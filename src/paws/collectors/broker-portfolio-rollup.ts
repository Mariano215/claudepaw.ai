// src/paws/collectors/broker-portfolio-rollup.ts
//
// Observe-phase collector for re-portfolio-health.
//
// Per-property roll-up + portfolio totals. The ANALYZE LLM should never
// have to do amortization or portfolio-weighting math.
//
// v1 simplifications (called out in the returned shape so ANALYZE knows
// what is approximate):
//   * monthly_revenue: active lease monthly_rent for LTRs, OR sum of
//     str_bookings.net_payout where check_in is in the last 30 days for
//     STRs. Whichever applies given use_type. If both exist, lease wins.
//   * monthly_debt_service: standard amortization on the most recent loan
//     (P*r/(1-(1+r)^-n)) where r = annual rate / 12, n = term_months.
//     Returns null when rate or term_months is missing.
//   * operating_expenses_avg: monthly average of expenses excluding
//     category='mortgage' over the trailing 12 months (so we don't
//     double-count debt service).
//   * coc_ttm: 12 * monthly_net_cf / equity_in. equity_in is approximated
//     as (current_arv - last_loan_balance) at snapshot time. Real CoC
//     should use cash actually in the deal; track separately when ready.
//   * vacancy_pct_30d: STR-only, computed as 1 - (booked_nights / 30) over
//     the last 30 days of confirmed/in_stay/completed bookings.
//   * dscr: monthly_revenue / monthly_debt_service.
//   * portfolio.weighted_avg_dscr: weighted by monthly_revenue.

import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'

const MS_PER_DAY = 86_400_000

interface PropertyRow {
  id: string
  address: string
  use_type: string | null
  current_arv: number | null
}

interface LeaseRow {
  monthly_rent: number | null
}

interface BookingRow {
  net_payout: number | null
  check_in: string | null
  check_out: string | null
}

interface LoanRow {
  loan_amount: number | null
  rate: number | null
  term_months: number | null
}

interface ExpenseRow {
  amount: number
}

// Standard amortization: P*r/(1-(1+r)^-n). r = annual / 12.
// Returns null if any required input is missing or invalid.
function monthlyPayment(principal: number | null, annualRate: number | null, termMonths: number | null): number | null {
  if (principal === null || annualRate === null || termMonths === null) return null
  if (principal <= 0 || termMonths <= 0) return null
  if (annualRate <= 0) return principal / termMonths // 0% loan -> straight-line
  const r = annualRate / 12
  return (principal * r) / (1 - Math.pow(1 + r, -termMonths))
}

// Days between two YYYY-MM-DD dates (clamped to non-negative).
function nightCount(checkIn: string | null, checkOut: string | null): number {
  if (!checkIn || !checkOut) return 0
  const inMs = Date.parse(`${checkIn}T00:00:00Z`)
  const outMs = Date.parse(`${checkOut}T00:00:00Z`)
  if (Number.isNaN(inMs) || Number.isNaN(outMs)) return 0
  return Math.max(0, Math.round((outMs - inMs) / MS_PER_DAY))
}

// How many of the booking's nights actually fall inside the [windowStart, now] window?
// (clip to the intersection)
function nightsInWindow(checkIn: string | null, checkOut: string | null, windowStartMs: number, nowMs: number): number {
  if (!checkIn || !checkOut) return 0
  const inMs = Date.parse(`${checkIn}T00:00:00Z`)
  const outMs = Date.parse(`${checkOut}T00:00:00Z`)
  if (Number.isNaN(inMs) || Number.isNaN(outMs)) return 0
  const start = Math.max(inMs, windowStartMs)
  const end = Math.min(outMs, nowMs)
  return Math.max(0, Math.round((end - start) / MS_PER_DAY))
}

export const brokerPortfolioRollupCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()
  const window30StartMs = now - 30 * MS_PER_DAY
  const window12mStartMs = now - 365 * MS_PER_DAY
  // Used to filter expenses by occurred_on (TEXT YYYY-MM-DD).
  const window12mStartIso = new Date(window12mStartMs).toISOString().slice(0, 10)
  const window30StartIso = new Date(window30StartMs).toISOString().slice(0, 10)

  // ---------------------------------------------------------------------
  // 1. All active properties.
  // ---------------------------------------------------------------------
  let properties: PropertyRow[] = []
  try {
    const db = getDb()
    properties = db.prepare(`
      SELECT id, address, use_type, current_arv
      FROM properties
      WHERE project_id = ?
        AND status = 'active'
      ORDER BY address ASC
    `).all(ctx.projectId) as PropertyRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`properties query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-portfolio-rollup] properties query failed')
  }

  const perProperty = properties.map((p) => {
    // Active LTR lease rent
    let leaseRent: number | null = null
    try {
      const db = getDb()
      const row = db.prepare(`
        SELECT monthly_rent
        FROM leases
        WHERE project_id = ?
          AND property_id = ?
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      `).get(ctx.projectId, p.id) as LeaseRow | undefined
      leaseRent = row?.monthly_rent ?? null
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`lease lookup failed for ${p.id}: ${msg}`)
      logger.warn({ err, pawId: ctx.pawId, propertyId: p.id }, '[broker-portfolio-rollup] lease lookup failed')
    }

    // STR bookings in the last 30 days (any state that produced revenue / occupies the calendar)
    let strBookings: BookingRow[] = []
    try {
      const db = getDb()
      strBookings = db.prepare(`
        SELECT net_payout, check_in, check_out
        FROM str_bookings
        WHERE project_id = ?
          AND property_id = ?
          AND status IN ('confirmed','in_stay','completed')
          AND check_out >= ?
      `).all(ctx.projectId, p.id, window30StartIso) as BookingRow[]
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`str bookings lookup failed for ${p.id}: ${msg}`)
      logger.warn({ err, pawId: ctx.pawId, propertyId: p.id }, '[broker-portfolio-rollup] str lookup failed')
    }

    const strNetPayout30d = strBookings.reduce((acc, b) => acc + (b.net_payout ?? 0), 0)
    const bookedNights30d = strBookings.reduce(
      (acc, b) => acc + nightsInWindow(b.check_in, b.check_out, window30StartMs, now),
      0,
    )
    const isStr = p.use_type === 'str' || (leaseRent === null && strBookings.length > 0)

    // Lease wins when present; STR fallback otherwise.
    const monthlyRevenue = leaseRent !== null ? leaseRent : (isStr ? strNetPayout30d : 0)

    // STR-only vacancy
    let vacancyPct30d: number | null = null
    if (isStr) {
      vacancyPct30d = Math.max(0, Math.min(1, 1 - bookedNights30d / 30))
    }

    // Latest loan -> debt service
    let loanRow: LoanRow | undefined
    try {
      const db = getDb()
      loanRow = db.prepare(`
        SELECT loan_amount, rate, term_months
        FROM financing_events
        WHERE project_id = ?
          AND property_id = ?
          AND event_type IN ('purchase','refi','dscr_loan','hard_money')
          AND loan_amount IS NOT NULL
        ORDER BY (closing_date IS NULL), closing_date DESC, created_at DESC
        LIMIT 1
      `).get(ctx.projectId, p.id) as LoanRow | undefined
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`loan lookup failed for ${p.id}: ${msg}`)
      logger.warn({ err, pawId: ctx.pawId, propertyId: p.id }, '[broker-portfolio-rollup] loan lookup failed')
    }

    const monthlyDebtService = monthlyPayment(
      loanRow?.loan_amount ?? null,
      loanRow?.rate ?? null,
      loanRow?.term_months ?? null,
    )

    // Operating expense average / mo over trailing 12 mo, mortgage excluded.
    let opex12mTotal = 0
    try {
      const db = getDb()
      const rows = db.prepare(`
        SELECT amount
        FROM expenses
        WHERE project_id = ?
          AND property_id = ?
          AND category != 'mortgage'
          AND occurred_on >= ?
      `).all(ctx.projectId, p.id, window12mStartIso) as ExpenseRow[]
      opex12mTotal = rows.reduce((acc, r) => acc + (r.amount ?? 0), 0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`expenses lookup failed for ${p.id}: ${msg}`)
      logger.warn({ err, pawId: ctx.pawId, propertyId: p.id }, '[broker-portfolio-rollup] expenses lookup failed')
    }
    const opexAvgMonthly = opex12mTotal / 12

    const dscr =
      monthlyDebtService !== null && monthlyDebtService > 0
        ? monthlyRevenue / monthlyDebtService
        : null

    // CoC TTM. equity_in approximated as ARV - last_loan_balance.
    const equityIn =
      p.current_arv !== null && loanRow?.loan_amount !== undefined && loanRow?.loan_amount !== null
        ? p.current_arv - loanRow.loan_amount
        : null
    const monthlyNetCf =
      monthlyDebtService !== null
        ? monthlyRevenue - monthlyDebtService - opexAvgMonthly
        : null
    const cocTtm =
      monthlyNetCf !== null && equityIn !== null && equityIn > 0
        ? (12 * monthlyNetCf) / equityIn
        : null

    return {
      property_id: p.id,
      address: p.address,
      use_type: p.use_type,
      monthly_revenue: monthlyRevenue,
      monthly_debt_service: monthlyDebtService,
      dscr,
      vacancy_pct_30d: vacancyPct30d,
      coc_ttm: cocTtm,
      // Pass-through fields the ANALYZE prompt may want for "worst-door" callouts:
      _monthly_net_cf: monthlyNetCf,
      _equity_in: equityIn,
      _opex_avg_monthly: opexAvgMonthly,
    }
  })

  // ---------------------------------------------------------------------
  // Portfolio totals
  // ---------------------------------------------------------------------
  const totalDoors = perProperty.length

  // Weighted DSCR: sum(rev) / sum(debt). Skip rows where either is null.
  let revSumForDscr = 0
  let debtSumForDscr = 0
  for (const r of perProperty) {
    if (r.dscr !== null && r.monthly_debt_service !== null) {
      revSumForDscr += r.monthly_revenue
      debtSumForDscr += r.monthly_debt_service
    }
  }
  const weightedAvgDscr = debtSumForDscr > 0 ? revSumForDscr / debtSumForDscr : null

  // Blended CoC: sum(net_cf) * 12 / sum(equity_in).
  let netCfSum = 0
  let equitySum = 0
  let cfRows = 0
  for (const r of perProperty) {
    if (r._monthly_net_cf !== null && r._equity_in !== null && r._equity_in > 0) {
      netCfSum += r._monthly_net_cf
      equitySum += r._equity_in
      cfRows += 1
    }
  }
  const blendedCoc = cfRows > 0 && equitySum > 0 ? (12 * netCfSum) / equitySum : null

  // Total equity (positive contributions only)
  let totalEquity = 0
  for (const r of perProperty) {
    if (r._equity_in !== null && r._equity_in > 0) totalEquity += r._equity_in
  }

  // Monthly cash flow: sum(monthly_net_cf) where computable
  let monthlyCashFlow = 0
  for (const r of perProperty) {
    if (r._monthly_net_cf !== null) monthlyCashFlow += r._monthly_net_cf
  }

  // Strip the "_" pass-through fields from the public per_property shape.
  const publicPerProperty = perProperty.map((r) => ({
    property_id: r.property_id,
    address: r.address,
    use_type: r.use_type,
    monthly_revenue: r.monthly_revenue,
    monthly_debt_service: r.monthly_debt_service,
    dscr: r.dscr,
    vacancy_pct_30d: r.vacancy_pct_30d,
    coc_ttm: r.coc_ttm,
  }))

  const raw_data = {
    collected_at_ms: now,
    per_property: publicPerProperty,
    portfolio: {
      total_doors: totalDoors,
      weighted_avg_dscr: weightedAvgDscr,
      blended_coc: blendedCoc,
      total_equity: totalEquity,
      monthly_cash_flow: monthlyCashFlow,
    },
  }

  logger.info(
    {
      pawId: ctx.pawId,
      totalDoors,
      weightedAvgDscr,
      blendedCoc,
      totalEquity: Math.round(totalEquity),
    },
    '[broker-portfolio-rollup] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-portfolio-rollup',
    errors: errors.length ? errors : undefined,
  }
}
