import { BOT_API_TOKEN, DASHBOARD_URL } from '../config.js'
import { logger } from '../logger.js'
import { sendSystemAlert } from '../system-alert.js'

/** Consecutive fetch failures before the break-glass alert fires. With the
 *  15s TTL cache and per-tick callers this is reached within minutes of a
 *  real outage, while a single blip stays silent. */
const ALERT_AFTER_FAILURES = 3
let consecutiveFailures = 0

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
    if (consecutiveFailures >= ALERT_AFTER_FAILURES) {
      // Recovery after an alerted outage: say so (own rate-limit key, so the
      // recovery notice is not swallowed by the outage alert's limiter).
      void sendSystemAlert('dashboard-recovered', 'Dashboard is reachable again. Gates are back on authoritative state.')
    }
    consecutiveFailures = 0

    return value
  } catch (err) {
    // Break-glass observability (operator-approved 2026-06-11): the Jun 8-11
    // outage was silent for 3 days because this same unreachability also
    // blocked every gated Telegram send. Alert directly (rate-limited,
    // hardcoded text) once the failure persists.
    consecutiveFailures += 1
    if (consecutiveFailures >= ALERT_AFTER_FAILURES) {
      void sendSystemAlert(
        'dashboard-unreachable',
        `Dashboard at ${DASHBOARD_URL || 'http://127.0.0.1:3000'} is unreachable (${consecutiveFailures} consecutive gate checks). ` +
          (haveAuthoritative
            ? 'Running on last known kill-switch state; cost gates are failing open.'
            : 'Kill switch is FAIL-CLOSED: agent runs, sends, and scheduler ticks are blocked until the dashboard answers.'),
      )
    }
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
  consecutiveFailures = 0
  if (!opts?.keepStale) {
    staleCache = null
    haveAuthoritative = false
  }
}
