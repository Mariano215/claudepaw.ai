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
  // Trader-reserve slice fields (optional; absent on legacy/fail-open paths).
  // scope reflects how the gate evaluated this request:
  //   'trader'    -> trader project/role: never failed over to ollama; runs until the global cap
  //   'nontrader' -> capped at (global - reserve) so it can never cross into the trader slice
  //   'global'    -> dashboard/display view (no project scope supplied)
  scope?: 'trader' | 'nontrader' | 'global'
  total_spend_usd?: number
  trader_spend_usd?: number
  nontrader_spend_usd?: number
  reserve_usd?: number
  nontrader_cap_usd?: number
  // Soft-threshold warning (early alert), e.g. trader spend past 80% of its reserve.
  warn?: string | null
}

// Pool-counting providers — must match src/agent-runtime.ts:countsAgainstAgentSdkPool.
const POOL_COUNTING_PROVIDERS = ['claude_desktop', 'anthropic_api'] as const

// Trader is walled off from the ollama failover: trade decisions need reliable
// structured-JSON veto logic that local Gemma fumbles (trips the parse-failure
// auto-abstain bug), and analyst/watchdog reports feed financial judgment. The
// gate therefore (a) never routes trader to ollama and (b) reserves a slice of
// the pool so non-trader spend can never starve the product being validated.
// Detection is by project_id OR a caller tag starting with "trader" (the trader
// committee tags its roles "trader.committee.*"). Either match counts.
const TRADER_PROJECT_ID = 'trader'

function isTraderScope(projectId?: string | null, callerTag?: string | null): boolean {
  if (projectId === TRADER_PROJECT_ID) return true
  if (typeof callerTag === 'string' && callerTag.toLowerCase().startsWith('trader')) return true
  return false
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

// ---------------------------------------------------------------------------
// Pool-level gate (post-June-15 2026 Anthropic Agent SDK Credit Pool)
// ---------------------------------------------------------------------------

/**
 * Compute Anthropic Agent SDK Credit Pool status, trader-reserve aware.
 *
 * Spend = SUM(agent_events.total_cost_usd) for the current calendar month where
 * executed_provider counts against the pool. Post-June-15 2026 this approximates
 * real Anthropic credit consumption: the claude-mem observer runs on local Gemma
 * now, and interactive Claude Code stays on the subscription, so the credit pool
 * is essentially headless Agent SDK spend, which is what agent_events records.
 *
 * Budget tiers (env-tunable):
 *   AGENT_SDK_POOL_CAP_USD        default 200   global hard-stop (everything, incl. trader)
 *   AGENT_SDK_TRADER_RESERVE_USD  default 40    floor reserved for trader (the product)
 *   AGENT_SDK_POOL_OVERRIDE_PCT   default 0.80  non-trader -> ollama at 80% of the non-trader cap
 *     => non-trader cap            = 200 - 40 = 160  (non-trader hard-stop / refuse)
 *     => non-trader ollama failover = 0.80 * 160 = 128
 *     => trader early-warning       = 0.80 * 40  = 32
 *
 * Per-request behavior (scope derived from projectId / callerTag):
 *   trader     -> NEVER override_to_ollama. Allowed until total >= cap, then refuse.
 *                 The reserve guarantees trader at least `reserve` of headroom,
 *                 because non-trader can never spend past (cap - reserve).
 *   non-trader -> override_to_ollama at >= 128; refuse at >= 160 (its cap) or total >= 200.
 *   global     -> dashboard/display view: action mirrors the non-trader thresholds
 *                 against total spend.
 *
 * projected_eom_usd: linear extrapolation of total MTD spend; dashboard-only.
 */
export function computePoolGateStatus(
  opts?: { projectId?: string | null; callerTag?: string | null },
): PoolGateStatus {
  const capUsd = Number(process.env.AGENT_SDK_POOL_CAP_USD ?? 200)
  const reserveUsd = Math.min(Math.max(Number(process.env.AGENT_SDK_TRADER_RESERVE_USD ?? 40), 0), capUsd)
  const overridePct = Number(process.env.AGENT_SDK_POOL_OVERRIDE_PCT ?? 0.80)
  const nonTraderCap = Math.max(capUsd - reserveUsd, 0)
  const nonTraderOverrideUsd = nonTraderCap * overridePct
  const traderAlertUsd = reserveUsd * overridePct

  const isTrader = isTraderScope(opts?.projectId, opts?.callerTag)
  const scope: PoolGateStatus['scope'] = isTrader
    ? 'trader'
    : (opts?.projectId || opts?.callerTag) ? 'nontrader' : 'global'

  const db = getTelemetryDb()
  if (!db) {
    // Fail open: a telemetry outage must never block agent execution. The
    // per-project gate downstream remains the backstop.
    return {
      action: 'allow',
      spend_usd: 0,
      cap_usd: capUsd,
      percent_of_pool: 0,
      override_threshold_pct: overridePct * 100,
      hardstop_threshold_pct: 100,
      projected_eom_usd: 0,
      scope,
      total_spend_usd: 0,
      trader_spend_usd: 0,
      nontrader_spend_usd: 0,
      reserve_usd: reserveUsd,
      nontrader_cap_usd: nonTraderCap,
      warn: null,
    }
  }

  const ms = monthStart()
  const placeholders = POOL_COUNTING_PROVIDERS.map(() => '?').join(',')
  const totalRow = db.prepare(
    `SELECT COALESCE(SUM(total_cost_usd), 0) AS total
       FROM agent_events
      WHERE received_at >= ? AND executed_provider IN (${placeholders})`,
  ).get(ms, ...POOL_COUNTING_PROVIDERS) as { total: number }
  const traderRow = db.prepare(
    `SELECT COALESCE(SUM(total_cost_usd), 0) AS total
       FROM agent_events
      WHERE received_at >= ? AND project_id = ? AND executed_provider IN (${placeholders})`,
  ).get(ms, TRADER_PROJECT_ID, ...POOL_COUNTING_PROVIDERS) as { total: number }

  const total = totalRow.total ?? 0
  const traderSpend = traderRow.total ?? 0
  const nonTraderSpend = Math.max(total - traderSpend, 0)

  let action: PoolGateStatus['action'] = 'allow'
  let warn: string | null = null

  if (isTrader) {
    // Trader: never fail over to ollama. Runs on Claude until the GLOBAL cap.
    if (total >= capUsd) action = 'refuse'
    if (action === 'allow' && traderSpend >= traderAlertUsd) {
      warn = `trader credit spend $${traderSpend.toFixed(2)} past 80% of its $${reserveUsd} reserve (global pool $${total.toFixed(2)}/$${capUsd})`
    }
  } else {
    // Non-trader: capped at (cap - reserve) so the trader slice stays protected.
    if (total >= capUsd) action = 'refuse'
    else if (nonTraderSpend >= nonTraderCap) action = 'refuse'
    else if (nonTraderSpend >= nonTraderOverrideUsd) action = 'override_to_ollama'

    if (action === 'override_to_ollama') {
      warn = `non-trader credit spend $${nonTraderSpend.toFixed(2)} past failover threshold $${nonTraderOverrideUsd.toFixed(2)} (cap $${nonTraderCap}, $${reserveUsd} reserved for trader)`
    } else if (action === 'refuse') {
      warn = `non-trader credit budget exhausted: $${nonTraderSpend.toFixed(2)} of $${nonTraderCap} ($${reserveUsd} reserved for trader; global $${total.toFixed(2)}/$${capUsd})`
    }
  }

  // Linear EOM projection on total spend (dashboard only; not a gate input).
  // Floor at actual spend (never project lower than what is already burned).
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
  const projectedEom = Math.max(total, total / fraction)

  const percent = capUsd > 0 ? Math.min((total / capUsd) * 100, 10000) : 0

  return {
    action,
    spend_usd: Math.round(total * 100) / 100,
    cap_usd: capUsd,
    percent_of_pool: Math.round(percent * 10) / 10,
    override_threshold_pct: overridePct * 100,
    hardstop_threshold_pct: 100,
    projected_eom_usd: Math.round(projectedEom * 100) / 100,
    scope,
    total_spend_usd: Math.round(total * 100) / 100,
    trader_spend_usd: Math.round(traderSpend * 100) / 100,
    nontrader_spend_usd: Math.round(nonTraderSpend * 100) / 100,
    reserve_usd: reserveUsd,
    nontrader_cap_usd: nonTraderCap,
    warn,
  }
}
