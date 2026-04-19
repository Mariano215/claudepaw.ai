import { getTelemetryDb } from './db.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostGateStatus {
  action: 'allow' | 'override_to_ollama' | 'refuse'
  percent_of_cap: number
  mtd_usd: number
  today_usd: number
  monthly_cap_usd: number | null
  daily_cap_usd: number | null
  triggering_cap: 'monthly' | 'daily' | null
}

// ---------------------------------------------------------------------------
// Timestamp helpers (milliseconds)
// ---------------------------------------------------------------------------

function monthStart(): number {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function dayStart(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// ---------------------------------------------------------------------------
// Zero result (returned when no caps are configured or DB is unavailable)
// ---------------------------------------------------------------------------

function zeroCaps(
  caps: { monthly_cost_cap_usd: number | null; daily_cost_cap_usd: number | null },
): CostGateStatus {
  return {
    action: 'allow',
    percent_of_cap: 0,
    mtd_usd: 0,
    today_usd: 0,
    monthly_cap_usd: caps.monthly_cost_cap_usd,
    daily_cap_usd: caps.daily_cost_cap_usd,
    triggering_cap: null,
  }
}

// ---------------------------------------------------------------------------
// Percent-of-cap helper
// cap=null  -> 0 (no cap, never triggers)
// cap=0     -> 100 if any spend exists, 0 if no spend (cap=0 means block all)
// cap>0     -> normal division, clamped to [0, 10000]
// ---------------------------------------------------------------------------

function percentOf(usd: number, cap: number | null): number {
  if (cap === null) return 0
  if (cap <= 0) return usd > 0 ? 100 : 0
  return Math.min((usd / cap) * 100, 10000)
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function computeCostGateStatus(
  projectId: string,
  caps: { monthly_cost_cap_usd: number | null; daily_cost_cap_usd: number | null },
): CostGateStatus {
  const db = getTelemetryDb()

  // DB unavailable - fail open (allow) with zeroed costs
  if (!db) {
    return zeroCaps(caps)
  }

  // No caps configured - return early without querying the DB
  if (caps.monthly_cost_cap_usd === null && caps.daily_cost_cap_usd === null) {
    return zeroCaps(caps)
  }

  const ms = monthStart()
  const ds = dayStart()

  const mtdRow = db.prepare(
    `SELECT COALESCE(SUM(total_cost_usd), 0) AS total
       FROM agent_events
      WHERE project_id = ? AND received_at >= ?`,
  ).get(projectId, ms) as { total: number }

  const todayRow = db.prepare(
    `SELECT COALESCE(SUM(total_cost_usd), 0) AS total
       FROM agent_events
      WHERE project_id = ? AND received_at >= ?`,
  ).get(projectId, ds) as { total: number }

  const mtdUsd = mtdRow.total
  const todayUsd = todayRow.total

  const monthlyPct = percentOf(mtdUsd, caps.monthly_cost_cap_usd)
  const dailyPct = percentOf(todayUsd, caps.daily_cost_cap_usd)

  const pct = Math.max(monthlyPct, dailyPct)

  // triggering_cap: daily wins when its pct is strictly greater; otherwise monthly.
  // Tie: monthly wins (equal percents with both caps set).
  // null only when both caps are null (handled above by early return).
  let triggeringCap: 'monthly' | 'daily' | null
  if (caps.daily_cost_cap_usd !== null && dailyPct > monthlyPct) {
    triggeringCap = 'daily'
  } else {
    triggeringCap = 'monthly'
  }

  let action: 'allow' | 'override_to_ollama' | 'refuse'
  if (pct >= 100) {
    action = 'refuse'
  } else if (pct >= 80) {
    action = 'override_to_ollama'
  } else {
    action = 'allow'
  }

  return {
    action,
    percent_of_cap: Math.round(pct * 10) / 10,
    mtd_usd: mtdUsd,
    today_usd: todayUsd,
    monthly_cap_usd: caps.monthly_cost_cap_usd,
    daily_cap_usd: caps.daily_cost_cap_usd,
    triggering_cap: triggeringCap,
  }
}
