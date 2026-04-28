/**
 * broker-routes/portfolio.ts
 *
 * Two portfolio routes:
 *   GET /api/v1/broker/portfolio-rollup -- equity stack, cash-flow,
 *                                          DSCR avg, vacancy %, per-property metrics
 *   GET /api/v1/broker/str-bookings     -- bookings list + per-property
 *                                          ADR / occupancy / RevPAR / total_revenue
 *                                          / total_nights metrics
 *
 * Computation rules:
 *   - All money is USD, kept as REAL in the DB.
 *   - Equity stack = sum(properties.current_arv) - sum(latest open
 *     financing_events.loan_amount per property). Properties with no
 *     ARV are excluded from the equity total but counted toward
 *     property_count.
 *   - Monthly cash-flow uses the most recent 30 days of expenses + the
 *     last 30 days of confirmed/completed STR net_payouts + active
 *     lease monthly_rent (sum). Expenses subtract.
 *   - DSCR per-property = (annualized cashflow) / (annual debt service).
 *     The portfolio DSCR is the unweighted mean of property-level DSCRs
 *     where annual debt service > 0; properties with no debt are excluded.
 *   - Vacancy % = (active LTR properties without an active lease) /
 *     (active LTR properties total). For STR use_type='str' it is
 *     (1 - occupancy_pct mean) over the last 30 days, expressed as %.
 *   - per_property[].metrics include rent_or_revenue_30d, expenses_30d,
 *     net_30d, equity, equity_pct, debt, dscr, vacancy_flag.
 */

import { Router, type Request, type Response } from 'express'
import { logger } from '../logger.js'
import { serverDb } from './shared.js'

const router = Router()

interface PropertyRow {
  id: string
  project_id: string
  address: string
  use_type: string | null
  current_arv: number | null
  cost_basis: number | null
  acquisition_price: number | null
  status: string
}

interface FinancingRow {
  id: string
  property_id: string | null
  event_type: string
  loan_amount: number | null
  rate: number | null
  term_months: number | null
  closing_date: string | null
  created_at: number
}

interface LeaseRow {
  id: string
  property_id: string
  monthly_rent: number | null
  status: string
}

interface BookingRow {
  id: string
  property_id: string
  platform: string
  check_in: string | null
  check_out: string | null
  nights: number | null
  gross_rev: number | null
  fees: number | null
  net_payout: number | null
  status: string
  created_at: number
}

interface ExpenseRow {
  property_id: string | null
  amount: number
  occurred_on: string
  category: string
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Resolve which project_ids the caller may read. Returns:
 *   - null: caller is admin and asked for "all" (no filter)
 *   - string[] (possibly empty): caller is scoped to these ids
 *   - false: caller has no access at all (caller should respond [])
 */
function resolveProjectFilter(req: Request): string[] | null | false {
  const isAdmin = req.user?.isAdmin === true
  const allowed = req.scope?.allowedProjectIds
  const requested = typeof req.query.project_id === 'string' ? req.query.project_id : null

  if (isAdmin) {
    return requested ? [requested] : null
  }
  const pids = allowed ?? []
  if (pids.length === 0) return false
  if (requested) {
    if (!pids.includes(requested)) return false
    return [requested]
  }
  return pids
}

function whereProject(filter: string[] | null, alias = ''): { sql: string; args: unknown[] } {
  if (filter === null) return { sql: '', args: [] }
  if (filter.length === 0) return { sql: '', args: [] }
  const col = alias ? `${alias}.project_id` : 'project_id'
  return {
    sql: `${col} IN (${filter.map(() => '?').join(',')})`,
    args: [...filter],
  }
}

router.get('/api/v1/broker/portfolio-rollup', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }
  const filter = resolveProjectFilter(req)
  if (filter === false) {
    res.json({
      property_count: 0,
      total_arv: 0,
      total_debt: 0,
      total_equity: 0,
      monthly_cash_flow: 0,
      avg_dscr: null,
      vacancy_pct_ltr: null,
      vacancy_pct_str: null,
      per_property: [],
    })
    return
  }

  try {
    const propWhere = whereProject(filter)
    const properties = db
      .prepare(
        `SELECT id, project_id, address, use_type, current_arv, cost_basis,
                acquisition_price, status
         FROM properties
         ${propWhere.sql ? 'WHERE ' + propWhere.sql : ''}`,
      )
      .all(...propWhere.args) as PropertyRow[]

    const activeProps = properties.filter(p => p.status === 'active')
    const propIds = activeProps.map(p => p.id)
    if (propIds.length === 0) {
      res.json({
        property_count: properties.length,
        total_arv: 0,
        total_debt: 0,
        total_equity: 0,
        monthly_cash_flow: 0,
        avg_dscr: null,
        vacancy_pct_ltr: null,
        vacancy_pct_str: null,
        per_property: [],
      })
      return
    }

    // Latest financing event per property (excludes payoff/heloc_draw style
    // mutations would normally net here; v1 keeps it simple: most recent
    // non-payoff event with loan_amount > 0 wins).
    const placeholders = propIds.map(() => '?').join(',')
    const financingRows = db
      .prepare(`
        SELECT id, property_id, event_type, loan_amount, rate, term_months,
               closing_date, created_at
        FROM financing_events
        WHERE property_id IN (${placeholders})
        ORDER BY created_at DESC
      `)
      .all(...propIds) as FinancingRow[]

    const financingByProperty = new Map<string, FinancingRow>()
    for (const f of financingRows) {
      if (!f.property_id) continue
      if (f.event_type === 'payoff') {
        // A payoff zeroes out the debt for that property.
        financingByProperty.set(f.property_id, { ...f, loan_amount: 0 })
        continue
      }
      if (financingByProperty.has(f.property_id)) continue
      financingByProperty.set(f.property_id, f)
    }

    const leaseRows = db
      .prepare(`
        SELECT id, property_id, monthly_rent, status
        FROM leases
        WHERE property_id IN (${placeholders})
      `)
      .all(...propIds) as LeaseRow[]

    const leasesByProperty = new Map<string, LeaseRow[]>()
    for (const l of leaseRows) {
      if (!leasesByProperty.has(l.property_id)) leasesByProperty.set(l.property_id, [])
      leasesByProperty.get(l.property_id)!.push(l)
    }

    const since30 = Date.now() - 30 * MS_PER_DAY
    const since30Date = new Date(since30).toISOString().slice(0, 10)

    const bookingRows = db
      .prepare(`
        SELECT id, property_id, net_payout, nights, gross_rev, check_in, check_out, status
        FROM str_bookings
        WHERE property_id IN (${placeholders})
          AND check_out >= ?
      `)
      .all(...propIds, since30Date) as Array<Pick<BookingRow, 'id' | 'property_id' | 'net_payout' | 'nights' | 'gross_rev' | 'check_in' | 'check_out' | 'status'>>

    const bookingsByProperty = new Map<string, typeof bookingRows>()
    for (const b of bookingRows) {
      if (!bookingsByProperty.has(b.property_id)) bookingsByProperty.set(b.property_id, [])
      bookingsByProperty.get(b.property_id)!.push(b)
    }

    const expenseRows = db
      .prepare(`
        SELECT property_id, amount, occurred_on, category
        FROM expenses
        WHERE (property_id IN (${placeholders}) OR property_id IS NULL)
          AND occurred_on >= ?
      `)
      .all(...propIds, since30Date) as ExpenseRow[]

    const expensesByProperty = new Map<string, number>()
    let unallocatedExpenses = 0
    for (const e of expenseRows) {
      if (!e.property_id) {
        unallocatedExpenses += e.amount
        continue
      }
      expensesByProperty.set(e.property_id, (expensesByProperty.get(e.property_id) ?? 0) + e.amount)
    }

    let totalArv = 0
    let totalDebt = 0
    let monthlyCashFlow = 0
    const dscrValues: number[] = []
    let ltrTotal = 0
    let ltrVacant = 0

    const perProperty = activeProps.map(p => {
      const arv = p.current_arv ?? 0
      const fin = financingByProperty.get(p.id)
      const debt = fin?.loan_amount ?? 0
      totalArv += arv
      totalDebt += debt

      const equity = Math.max(0, arv - debt)
      const equityPct = arv > 0 ? equity / arv : null

      // Revenue: STR uses 30-day net_payout; LTR uses sum of active lease rents.
      const leases = leasesByProperty.get(p.id) ?? []
      const activeLeaseRent = leases
        .filter(l => l.status === 'active')
        .reduce((acc, l) => acc + (l.monthly_rent ?? 0), 0)
      const bookings = bookingsByProperty.get(p.id) ?? []
      const strRevenue30 = bookings.reduce((acc, b) => acc + (b.net_payout ?? 0), 0)

      const isStr = p.use_type === 'str'
      const rentOrRevenue30 = isStr ? strRevenue30 : activeLeaseRent
      const expenses30 = expensesByProperty.get(p.id) ?? 0
      const net30 = rentOrRevenue30 - expenses30
      monthlyCashFlow += net30

      // DSCR per property: monthly NOI annualised / annual debt service.
      // Approximate annual debt service from rate + loan_amount + term_months.
      let dscr: number | null = null
      if (debt > 0 && fin?.rate != null && fin.term_months != null && fin.term_months > 0) {
        const monthlyRate = fin.rate / 12
        const n = fin.term_months
        let monthlyPayment: number
        if (monthlyRate === 0) {
          monthlyPayment = debt / n
        } else {
          monthlyPayment = (debt * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -n))
        }
        const annualDebt = monthlyPayment * 12
        const annualNoi = (rentOrRevenue30 - expenses30) * 12
        if (annualDebt > 0) {
          dscr = annualNoi / annualDebt
          dscrValues.push(dscr)
        }
      }

      let vacancyFlag = false
      if (p.use_type === 'ltr') {
        ltrTotal += 1
        const hasActiveLease = leases.some(l => l.status === 'active')
        if (!hasActiveLease) {
          ltrVacant += 1
          vacancyFlag = true
        }
      }

      return {
        id: p.id,
        address: p.address,
        use_type: p.use_type,
        status: p.status,
        metrics: {
          arv,
          debt,
          equity,
          equity_pct: equityPct,
          rent_or_revenue_30d: rentOrRevenue30,
          expenses_30d: expenses30,
          net_30d: net30,
          dscr,
          vacancy_flag: vacancyFlag,
        },
      }
    })

    monthlyCashFlow -= unallocatedExpenses

    const totalEquity = Math.max(0, totalArv - totalDebt)
    const avgDscr = dscrValues.length > 0
      ? dscrValues.reduce((a, b) => a + b, 0) / dscrValues.length
      : null
    const vacancyPctLtr = ltrTotal > 0 ? ltrVacant / ltrTotal : null

    // STR vacancy: 1 - mean(occupancy) over the last 30 days for str_use props.
    const strProps = activeProps.filter(p => p.use_type === 'str')
    let vacancyPctStr: number | null = null
    if (strProps.length > 0) {
      const occRates: number[] = []
      for (const p of strProps) {
        const bs = bookingsByProperty.get(p.id) ?? []
        const nights = bs.reduce((acc, b) => acc + (b.nights ?? 0), 0)
        const occ = Math.min(1, nights / 30)
        occRates.push(occ)
      }
      const mean = occRates.reduce((a, b) => a + b, 0) / occRates.length
      vacancyPctStr = 1 - mean
    }

    res.json({
      property_count: activeProps.length,
      total_arv: totalArv,
      total_debt: totalDebt,
      total_equity: totalEquity,
      monthly_cash_flow: monthlyCashFlow,
      unallocated_expenses_30d: unallocatedExpenses,
      avg_dscr: avgDscr,
      vacancy_pct_ltr: vacancyPctLtr,
      vacancy_pct_str: vacancyPctStr,
      per_property: perProperty,
    })
  } catch (err) {
    logger.warn({ err }, 'broker: portfolio-rollup failed')
    res.status(500).json({ error: 'failed to compute portfolio rollup' })
  }
})

router.get('/api/v1/broker/str-bookings', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }
  const filter = resolveProjectFilter(req)
  if (filter === false) {
    res.json({ bookings: [], per_property: [] })
    return
  }

  try {
    const propWhere = whereProject(filter)
    const properties = db
      .prepare(`SELECT id, address FROM properties ${propWhere.sql ? 'WHERE ' + propWhere.sql : ''}`)
      .all(...propWhere.args) as Array<{ id: string; address: string }>
    const propIds = properties.map(p => p.id)
    if (propIds.length === 0) {
      res.json({ bookings: [], per_property: [] })
      return
    }

    const placeholders = propIds.map(() => '?').join(',')
    const bookings = db
      .prepare(`
        SELECT id, project_id, property_id, platform, guest_name, check_in,
               check_out, nights, gross_rev, fees, net_payout, status, created_at
        FROM str_bookings
        WHERE property_id IN (${placeholders})
        ORDER BY check_in DESC
      `)
      .all(...propIds) as BookingRow[]

    // Per-property aggregates over all bookings (not 30-day window) so
    // the dashboard card can show lifetime ADR / RevPAR alongside the
    // 30d portfolio metrics.
    const groups = new Map<string, BookingRow[]>()
    for (const b of bookings) {
      if (!groups.has(b.property_id)) groups.set(b.property_id, [])
      groups.get(b.property_id)!.push(b)
    }

    const perProperty = properties.map(p => {
      const list = groups.get(p.id) ?? []
      const completed = list.filter(b => b.status === 'completed' || b.status === 'in_stay' || b.status === 'confirmed')
      const totalNights = completed.reduce((acc, b) => acc + (b.nights ?? 0), 0)
      const totalRevenue = completed.reduce((acc, b) => acc + (b.gross_rev ?? 0), 0)
      const adr = totalNights > 0 ? totalRevenue / totalNights : null
      // RevPAR uses gross revenue / available nights. Approximate available
      // nights as max(totalNights, completed booking date span). For v1,
      // treat each property's first-to-last check-out as its window.
      let availableNights = totalNights
      if (completed.length > 0) {
        const firstCheckIn = completed
          .map(b => b.check_in)
          .filter((x): x is string => Boolean(x))
          .sort()[0]
        const lastCheckOut = completed
          .map(b => b.check_out)
          .filter((x): x is string => Boolean(x))
          .sort()
          .at(-1)
        if (firstCheckIn && lastCheckOut) {
          const days = Math.max(
            1,
            Math.round((new Date(lastCheckOut).getTime() - new Date(firstCheckIn).getTime()) / MS_PER_DAY),
          )
          availableNights = days
        }
      }
      const occupancy = availableNights > 0 ? totalNights / availableNights : null
      const revpar = availableNights > 0 ? totalRevenue / availableNights : null

      return {
        property_id: p.id,
        address: p.address,
        total_nights: totalNights,
        total_revenue: totalRevenue,
        adr,
        occupancy,
        revpar,
        booking_count: list.length,
      }
    })

    res.json({ bookings, per_property: perProperty })
  } catch (err) {
    logger.warn({ err }, 'broker: str-bookings failed')
    res.status(500).json({ error: 'failed to compute str bookings' })
  }
})

export default router
