import { BOT_API_TOKEN, DASHBOARD_URL } from '../config.js'
import { logger } from '../logger.js'

export interface KillSwitchInfo {
  set_at: number
  reason: string
}

const TTL_MS = 15_000

// TTL cache: cleared when expired
interface CacheEntry {
  at: number
  value: KillSwitchInfo | null
}

let cache: CacheEntry | null = null

// Stale cache: last authoritative value from a successful fetch (any value).
// `haveAuthoritative` tracks whether we have ever seen a successful response so
// we can distinguish "null because server said not-tripped" from "null because
// we have never reached the server". The gate is FAIL-CLOSED per CLAUDE.md:
// when we have no authoritative value and the server is unreachable, we must
// report tripped so callers block.
let staleCache: KillSwitchInfo | null = null
let haveAuthoritative = false

export async function checkKillSwitch(): Promise<KillSwitchInfo | null> {
  const now = Date.now()

  if (cache !== null && now - cache.at < TTL_MS) {
    return cache.value
  }

  const baseUrl = DASHBOARD_URL || 'http://127.0.0.1:3000'
  const token = BOT_API_TOKEN
  const url = `${baseUrl}/api/v1/system-state/kill-switch`

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      headers: { 'x-dashboard-token': token },
    })

    const body = await res.json() as { active: boolean; reason?: string; set_at?: number }
    const value: KillSwitchInfo | null = body.active
      ? { reason: body.reason ?? '', set_at: body.set_at ?? 0 }
      : null

    cache = { at: Date.now(), value }
    staleCache = value
    haveAuthoritative = true

    return value
  } catch (err) {
    // Fail-closed: if we have never heard from the server, treat as tripped so
    // every caller (runAgent, ChannelManager.send, scheduler tick, and any
    // other gate consumer) blocks. Once we have at least one authoritative
    // value, fall back to that stale value (spec: "fail-closed when
    // unreachable" applied to pre-seed state).
    if (!haveAuthoritative) {
      logger.warn({ err }, 'kill-switch-client: dashboard unreachable before first success, fail-closed')
      return { set_at: 0, reason: 'kill-switch dashboard unreachable (fail-closed)' }
    }
    logger.warn({ err }, 'kill-switch-client: fetch failed, returning stale value')
    return staleCache
  }
}

export function _resetCache(opts?: { keepStale?: boolean }): void {
  cache = null
  if (!opts?.keepStale) {
    staleCache = null
    haveAuthoritative = false
  }
}
