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

/**
 * Status of the post-June-15 2026 Anthropic Agent SDK Credit Pool. Aggregates
 * spend across every project for the current calendar month where the executed
 * provider counts against Anthropic's metered bucket.
 *
 * Returned by /api/v1/cost-gate/pool. Consumed by the agent gate path
 * (src/agent.ts) and the dashboard usage widget.
 */
export interface PoolGateStatus {
  action: 'allow' | 'override_to_ollama' | 'refuse'
  spend_usd: number
  cap_usd: number
  percent_of_pool: number
  override_threshold_pct: number
  hardstop_threshold_pct: number
  projected_eom_usd: number
}

// Pool-counting providers — must match src/agent-runtime.ts:countsAgainstAgentSdkPool.
const POOL_COUNTING_PROVIDERS = ['claude_desktop', 'anthropic_api'] as const

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

// ---------------------------------------------------------------------------
// Pool-level gate (post-June-15 2026 Anthropic Agent SDK Credit Pool)
// ---------------------------------------------------------------------------

/**
 * Compute Anthropic Agent SDK Credit Pool status. Aggregates
 * agent_events.total_cost_usd across ALL projects for the current calendar
 * month where executed_provider counts against the pool.
 *
 * Thresholds (env-tunable):
 *   AGENT_SDK_POOL_CAP_USD          default 200   (Max 20x tier)
 *   AGENT_SDK_POOL_OVERRIDE_PCT     default 0.80  ($160 → switch to Ollama)
 *   AGENT_SDK_POOL_HARDSTOP_PCT     default 0.95  ($190 → refuse all runs)
 *
 * Projected end-of-month: linear extrapolation of MTD spend against elapsed
 * fraction of the month. Used by the dashboard widget; not a gate input.
 */
export function computePoolGateStatus(): PoolGateStatus {
  const capUsd = Number(process.env.AGENT_SDK_POOL_CAP_USD ?? 200)
  const overridePct = Number(process.env.AGENT_SDK_POOL_OVERRIDE_PCT ?? 0.80)
  const hardstopPct = Number(process.env.AGENT_SDK_POOL_HARDSTOP_PCT ?? 0.95)

  const db = getTelemetryDb()
  if (!db) {
    return {
      action: 'allow',
      spend_usd: 0,
      cap_usd: capUsd,
      percent_of_pool: 0,
      override_threshold_pct: overridePct * 100,
      hardstop_threshold_pct: hardstopPct * 100,
      projected_eom_usd: 0,
    }
  }

  const ms = monthStart()
  const placeholders = POOL_COUNTING_PROVIDERS.map(() => '?').join(',')
  const row = db.prepare(
    `SELECT COALESCE(SUM(total_cost_usd), 0) AS total
       FROM agent_events
      WHERE received_at >= ? AND executed_provider IN (${placeholders})`,
  ).get(ms, ...POOL_COUNTING_PROVIDERS) as { total: number }

  const spendUsd = row.total ?? 0
  const percent = capUsd > 0 ? Math.min((spendUsd / capUsd) * 100, 10000) : 0

  // Linear EOM projection: spend / fraction_of_month_elapsed.
  // Floor at the actual spend (never project lower than what's already burned).
  const now = Date.now()
  const monthEnd = (() => {
    const d = new Date()
    d.setMonth(d.getMonth() + 1, 1)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  })()
  const elapsed = now - ms
  const monthLen = monthEnd - ms
  const fraction = monthLen > 0 ? Math.max(elapsed / monthLen, 1 / 1000) : 1 // avoid /0 on day 1
  const projectedEom = Math.max(spendUsd, spendUsd / fraction)

  let action: PoolGateStatus['action'] = 'allow'
  if (percent >= hardstopPct * 100) action = 'refuse'
  else if (percent >= overridePct * 100) action = 'override_to_ollama'

  return {
    action,
    spend_usd: Math.round(spendUsd * 100) / 100,
    cap_usd: capUsd,
    percent_of_pool: Math.round(percent * 10) / 10,
    override_threshold_pct: overridePct * 100,
    hardstop_threshold_pct: hardstopPct * 100,
    projected_eom_usd: Math.round(projectedEom * 100) / 100,
  }
}
