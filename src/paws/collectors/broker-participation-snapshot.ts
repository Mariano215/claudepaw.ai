// src/paws/collectors/broker-participation-snapshot.ts
//
// Observe-phase collector for re-material-participation-tracker.
//
// Surfaces the STR loophole + REPS hour ledger so the daily ANALYZE LLM can
// nudge the operator without doing date or aggregation math.
//
// STR threshold: 100 hrs/property AND more than anyone else on that property
//   (the "more than anyone else" half is left to ANALYZE; this collector
//   only emits the YTD totals per property for participant='mariano').
// REPS threshold: 750 hrs/year AND >50% of personal services in real property
//   (the >50% half is left to ANALYZE; this collector emits totals).

import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'

const MS_PER_DAY = 86_400_000
const REPS_THRESHOLD = 750
const STR_THRESHOLD = 100

interface RepsRow {
  total_hours: number | null
}

interface StrRow {
  property_id: string | null
  total_hours: number | null
}

interface PropertyRow {
  id: string
  address: string
}

interface LastLogRow {
  last_date: string | null
}

// Day-of-year (1..365 or 1..366) for the supplied UTC timestamp.
function dayOfYearUtc(nowMs: number): number {
  const d = new Date(nowMs)
  const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 1)
  const todayUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return Math.floor((todayUtc - startOfYear) / MS_PER_DAY) + 1
}

// Total days in the supplied calendar year (handles leap years).
function daysInYear(year: number): number {
  return Math.floor((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / MS_PER_DAY)
}

// Diff a YYYY-MM-DD date string against today (UTC midnight floor).
function daysSince(dateStr: string | null, nowMs: number): number | null {
  if (!dateStr) return null
  const parsed = Date.parse(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(parsed)) return null
  const todayUtc = Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY
  return Math.floor((todayUtc - parsed) / MS_PER_DAY)
}

export const brokerParticipationSnapshotCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()
  const year = new Date(now).getUTCFullYear()
  const yearPrefix = `${year}-`
  const dayOfYear = dayOfYearUtc(now)
  const totalDaysInYear = daysInYear(year)
  const daysRemaining = totalDaysInYear - dayOfYear

  // ---------------------------------------------------------------------
  // 1. REPS hour total YTD: counted_for IN ('reps','both'),
  //    participant IN ('mariano','spouse'), date in current year.
  // ---------------------------------------------------------------------
  let repsHoursTotal = 0
  try {
    const db = getDb()
    const row = db.prepare(`
      SELECT COALESCE(SUM(hours), 0) AS total_hours
      FROM participation_log
      WHERE project_id = ?
        AND counted_for IN ('reps','both')
        AND participant IN ('mariano','spouse')
        AND date LIKE ?
    `).get(ctx.projectId, `${yearPrefix}%`) as RepsRow | undefined
    repsHoursTotal = row?.total_hours ?? 0
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`reps total query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-participation-snapshot] reps total query failed')
  }

  // REPS pace: extrapolate current trajectory to a full year and compare to 750.
  // pace_pct = (hours * days_in_year) / (day_of_year * threshold) * 100.
  // dayOfYear is always >= 1 by construction, so no divide-by-zero risk.
  const repsPacePct = (repsHoursTotal * totalDaysInYear) / (dayOfYear * REPS_THRESHOLD) * 100

  // ---------------------------------------------------------------------
  // 2. Per-property STR hours YTD: counted_for IN ('str','both'),
  //    participant='mariano', date in current year, GROUP BY property_id.
  //    property_id NULL is allowed (general non-property hours).
  // ---------------------------------------------------------------------
  let strRows: StrRow[] = []
  try {
    const db = getDb()
    strRows = db.prepare(`
      SELECT property_id, COALESCE(SUM(hours), 0) AS total_hours
      FROM participation_log
      WHERE project_id = ?
        AND counted_for IN ('str','both')
        AND participant = 'mariano'
        AND date LIKE ?
      GROUP BY property_id
      ORDER BY (property_id IS NULL), property_id ASC
    `).all(ctx.projectId, `${yearPrefix}%`) as StrRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`str per-property query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-participation-snapshot] str per-property query failed')
  }

  // ---------------------------------------------------------------------
  // 3. Address lookup for the property_ids returned above.
  //    Separate query rather than a JOIN so a missing properties row
  //    does not silently drop the hours bucket.
  // ---------------------------------------------------------------------
  const propertyIds = strRows.map((r) => r.property_id).filter((x): x is string => x !== null)
  const addressMap = new Map<string, string>()
  if (propertyIds.length > 0) {
    try {
      const db = getDb()
      const placeholders = propertyIds.map(() => '?').join(',')
      const rows = db.prepare(`
        SELECT id, address
        FROM properties
        WHERE project_id = ? AND id IN (${placeholders})
      `).all(ctx.projectId, ...propertyIds) as PropertyRow[]
      for (const r of rows) addressMap.set(r.id, r.address)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`property address lookup failed: ${msg}`)
      logger.warn({ err, pawId: ctx.pawId }, '[broker-participation-snapshot] property lookup failed')
    }
  }

  const perPropertyStrHours = strRows.map((r) => {
    const hours = r.total_hours ?? 0
    return {
      property_id: r.property_id,
      address: r.property_id ? addressMap.get(r.property_id) ?? null : null,
      str_hours_ytd: hours,
      threshold: STR_THRESHOLD,
      short_by: Math.max(0, STR_THRESHOLD - hours),
    }
  })

  // ---------------------------------------------------------------------
  // 4. Last log date across any participant / any property (project scoped).
  // ---------------------------------------------------------------------
  let lastLogDate: string | null = null
  try {
    const db = getDb()
    const row = db.prepare(`
      SELECT MAX(date) AS last_date
      FROM participation_log
      WHERE project_id = ?
    `).get(ctx.projectId) as LastLogRow | undefined
    lastLogDate = row?.last_date ?? null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`last log date query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-participation-snapshot] last log query failed')
  }
  const lastLogDaysAgo = daysSince(lastLogDate, now)

  const raw_data = {
    collected_at_ms: now,
    year,
    days_remaining_in_year: daysRemaining,
    reps_hours_total: repsHoursTotal,
    reps_threshold: REPS_THRESHOLD,
    reps_pace_pct: repsPacePct,
    per_property_str_hours: perPropertyStrHours,
    last_log_date: lastLogDate,
    last_log_days_ago: lastLogDaysAgo,
  }

  logger.info(
    {
      pawId: ctx.pawId,
      year,
      repsHoursTotal,
      repsPacePct: Math.round(repsPacePct),
      strBuckets: perPropertyStrHours.length,
      lastLogDaysAgo,
    },
    '[broker-participation-snapshot] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-participation-snapshot',
    errors: errors.length ? errors : undefined,
  }
}
