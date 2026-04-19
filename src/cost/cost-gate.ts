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

export async function getCostGateStatus(projectId: string): Promise<CostGateStatus> {
  const now = Date.now()
  const cached = cache.get(projectId)

  if (cached !== undefined && now - cached.at < TTL_MS) {
    return cached.value
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
}
