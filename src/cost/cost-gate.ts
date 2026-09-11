import { BOT_API_TOKEN, DASHBOARD_URL } from '../config.js'
import { logger } from '../logger.js'

export interface CostGateStatus {
  action: 'allow' | 'override_to_ollama' | 'refuse'
  percent_of_cap: number
  mtd_usd: number
  today_usd: number
  monthly_cap_usd: number | null
  daily_cap_usd: number | null
  triggering_cap: 'monthly' | 'daily' | null
  /** Set only when a fail-closed project's gate could not be read and was refused safely. */
  unavailable?: boolean
}

/**
 * Account-wide Anthropic Agent SDK Credit Pool status (post-June-15 2026).
 * Mirrors PoolGateStatus from server/src/cost-gate.ts.
 */
export interface PoolGateStatus {
  action: 'allow' | 'override_to_ollama' | 'refuse'
  spend_usd: number
  cap_usd: number
  percent_of_pool: number
  override_threshold_pct: number
  hardstop_threshold_pct: number
  projected_eom_usd: number
  // Trader-reserve slice fields (optional; mirror server/src/cost-gate.ts).
  scope?: 'trader' | 'nontrader' | 'global'
  total_spend_usd?: number
  trader_spend_usd?: number
  nontrader_spend_usd?: number
  reserve_usd?: number
  nontrader_cap_usd?: number
  warn?: string | null
  /** Set only when a fail-closed project's pool gate could not be read and was refused safely. */
  unavailable?: boolean
}

const POOL_FAIL_OPEN: PoolGateStatus = {
  action: 'allow',
  spend_usd: 0,
  cap_usd: 200,
  percent_of_pool: 0,
  override_threshold_pct: 80,
  hardstop_threshold_pct: 95,
  projected_eom_usd: 0,
}

/**
 * Projects whose runs are refused when the cost gate cannot be read.
 *
 * Everything else fails OPEN: a dashboard outage must not stop ordinary agent
 * work. A project lands here when an unpriced run is worse than no run at all,
 * which today means anything that moves money. Keep this list tiny.
 */
const FAIL_CLOSED_PROJECTS = new Set<string>(['trader'])

function failsClosed(projectId?: string): boolean {
  return projectId !== undefined && FAIL_CLOSED_PROJECTS.has(projectId)
}

const TTL_MS = 60_000

const FAIL_OPEN: CostGateStatus = {
  action: 'allow',
  percent_of_cap: 0,
  mtd_usd: 0,
  today_usd: 0,
  monthly_cap_usd: null,
  daily_cap_usd: null,
  triggering_cap: null,
}

const FAIL_CLOSED: CostGateStatus = {
  ...FAIL_OPEN,
  action: 'refuse',
  unavailable: true,
}

const POOL_FAIL_CLOSED: PoolGateStatus = {
  ...POOL_FAIL_OPEN,
  action: 'refuse',
  unavailable: true,
  warn: 'Credit-pool gate is unavailable; refusing the run safely.',
}

interface CacheEntry {
  at: number
  value: CostGateStatus
}

const cache = new Map<string, CacheEntry>()

// Cap the cache at a reasonable number of projects. Prevents unbounded growth
// in long-running bots that see many distinct project_id values (e.g. tests,
// migrations, deleted projects whose entries never get cleared). The cap is
// generous relative to the current 4-project footprint.
const MAX_CACHE_ENTRIES = 100

function pruneExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.at >= TTL_MS) cache.delete(key)
  }
}

export async function getCostGateStatus(projectId: string): Promise<CostGateStatus> {
  const now = Date.now()
  const cached = cache.get(projectId)

  if (cached !== undefined && now - cached.at < TTL_MS) {
    return cached.value
  }

  // Opportunistic eviction: on cache-miss, prune expired entries and evict
  // the oldest entry if we're over the cap. Keeps the map bounded without
  // needing a separate timer.
  if (cache.size >= MAX_CACHE_ENTRIES) {
    pruneExpired(now)
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value
      if (oldestKey !== undefined) cache.delete(oldestKey)
    }
  }

  const baseUrl = DASHBOARD_URL || 'http://127.0.0.1:3000'
  const token = BOT_API_TOKEN
  const url = `${baseUrl}/api/v1/cost-gate/${encodeURIComponent(projectId)}`

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: { 'x-dashboard-token': token },
    })

    if (!res.ok) {
      throw new Error(`cost-gate server returned ${res.status}`)
    }

    const body = await res.json() as Partial<CostGateStatus>

    const value: CostGateStatus = {
      action: body.action ?? 'allow',
      percent_of_cap: body.percent_of_cap ?? 0,
      mtd_usd: body.mtd_usd ?? 0,
      today_usd: body.today_usd ?? 0,
      monthly_cap_usd: body.monthly_cap_usd ?? null,
      daily_cap_usd: body.daily_cap_usd ?? null,
      triggering_cap: body.triggering_cap ?? null,
    }

    cache.set(projectId, { at: Date.now(), value })
    return value
  } catch (err) {
    const failClosed = failsClosed(projectId)
    logger.warn({ err, projectId }, failClosed
      ? 'cost-gate-client: gate unavailable for a fail-closed project, refusing'
      : 'cost-gate-client: fetch failed, returning fail-open')
    return failClosed ? FAIL_CLOSED : FAIL_OPEN
  }
}

export function _resetCache(): void {
  cache.clear()
  poolCache.clear()
}

// ---------------------------------------------------------------------------
// Pool gate client (Agent SDK Credit Pool, post-June-15 2026)
// ---------------------------------------------------------------------------

// Cached per scope key (projectId|callerTag): the gate now returns a different
// action for trader vs non-trader vs global, so a single shared entry would leak
// one scope's verdict onto another.
const poolCache = new Map<string, { at: number; value: PoolGateStatus }>()
const POOL_TTL_MS = 60_000
const POOL_MAX_CACHE_ENTRIES = 100

/**
 * Fetches account-wide Anthropic Agent SDK Credit Pool status from the
 * dashboard, scoped to the calling project. Cached 60s per scope. Non-trader
 * callers fail open on network errors so a dashboard outage does not block
 * general agent work. Trader callers fail closed because unknown financial
 * controls cannot authorize committee spend.
 *
 * Pass the run's projectId (and, once the trader ledger lands, a callerTag) so
 * the server applies the trader reserve + the trader ollama-exclusion. The bot
 * ALSO enforces the trader exclusion independently (see src/agent.ts) so a trade
 * decision can never be routed to local Gemma even if this call misfires.
 */
export async function getPoolGateStatus(
  projectId?: string,
  callerTag?: string,
): Promise<PoolGateStatus> {
  const now = Date.now()
  const key = `${projectId ?? ''}|${callerTag ?? ''}`
  const cached = poolCache.get(key)
  if (cached && now - cached.at < POOL_TTL_MS) return cached.value

  // Opportunistic eviction to keep the map bounded.
  if (poolCache.size >= POOL_MAX_CACHE_ENTRIES) {
    for (const [k, e] of poolCache) if (now - e.at >= POOL_TTL_MS) poolCache.delete(k)
    if (poolCache.size >= POOL_MAX_CACHE_ENTRIES) {
      const oldest = poolCache.keys().next().value
      if (oldest !== undefined) poolCache.delete(oldest)
    }
  }

  const baseUrl = DASHBOARD_URL || 'http://127.0.0.1:3000'
  const token = BOT_API_TOKEN
  const params = new URLSearchParams()
  if (projectId) params.set('projectId', projectId)
  if (callerTag) params.set('callerTag', callerTag)
  const qs = params.toString()
  const url = `${baseUrl}/api/v1/cost-gate/pool${qs ? `?${qs}` : ''}`

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: { 'x-dashboard-token': token },
    })
    if (!res.ok) throw new Error(`pool-gate server returned ${res.status}`)

    const body = await res.json() as Partial<PoolGateStatus>
    const value: PoolGateStatus = {
      action: body.action ?? 'allow',
      spend_usd: body.spend_usd ?? 0,
      cap_usd: body.cap_usd ?? 200,
      percent_of_pool: body.percent_of_pool ?? 0,
      override_threshold_pct: body.override_threshold_pct ?? 80,
      hardstop_threshold_pct: body.hardstop_threshold_pct ?? 100,
      projected_eom_usd: body.projected_eom_usd ?? 0,
      scope: body.scope,
      total_spend_usd: body.total_spend_usd,
      trader_spend_usd: body.trader_spend_usd,
      nontrader_spend_usd: body.nontrader_spend_usd,
      reserve_usd: body.reserve_usd,
      nontrader_cap_usd: body.nontrader_cap_usd,
      warn: body.warn ?? null,
    }
    poolCache.set(key, { at: Date.now(), value })
    return value
  } catch (err) {
    const failClosed = failsClosed(projectId)
    logger.warn({ err, projectId }, failClosed
      ? 'pool-gate-client: gate unavailable for a fail-closed project, refusing'
      : 'pool-gate-client: fetch failed, returning fail-open')
    return failClosed ? POOL_FAIL_CLOSED : POOL_FAIL_OPEN
  }
}
