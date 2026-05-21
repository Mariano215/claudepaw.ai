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
    logger.warn({ err, projectId }, 'cost-gate-client: fetch failed, returning fail-open')
    return FAIL_OPEN
  }
}

export function _resetCache(): void {
  cache.clear()
  poolCache = null
}

// ---------------------------------------------------------------------------
// Pool gate client (Agent SDK Credit Pool, post-June-15 2026)
// ---------------------------------------------------------------------------

let poolCache: { at: number; value: PoolGateStatus } | null = null
const POOL_TTL_MS = 60_000

/**
 * Fetches account-wide Anthropic Agent SDK Credit Pool status from the
 * dashboard. Cached 60s. Fails open on network errors (returns 0% spend,
 * action='allow') so a dashboard outage never blocks agent execution — the
 * per-project cost gate downstream remains the safety net.
 */
export async function getPoolGateStatus(): Promise<PoolGateStatus> {
  const now = Date.now()
  if (poolCache && now - poolCache.at < POOL_TTL_MS) return poolCache.value

  const baseUrl = DASHBOARD_URL || 'http://127.0.0.1:3000'
  const token = BOT_API_TOKEN
  const url = `${baseUrl}/api/v1/cost-gate/pool`

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
      hardstop_threshold_pct: body.hardstop_threshold_pct ?? 95,
      projected_eom_usd: body.projected_eom_usd ?? 0,
    }
    poolCache = { at: Date.now(), value }
    return value
  } catch (err) {
    logger.warn({ err }, 'pool-gate-client: fetch failed, returning fail-open')
    return POOL_FAIL_OPEN
  }
}
