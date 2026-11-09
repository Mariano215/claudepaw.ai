// Quota awareness system. Centralizes external API call logging,
// quota error detection, and cooldown enforcement across every
// integration the metrics collectors and dashboard proxies hit.

import { getDb } from './db.js'
import { logger } from './logger.js'

// Per-platform default cooldown when a quota/rate-limit error is detected.
// Most APIs reset on a wall-clock boundary; for safety we wait until that
// boundary plus a small buffer. Caller code never needs to know these.
const COOLDOWN_HOURS: Record<string, number> = {
  youtube: 24,    // YouTube Data API resets daily at midnight Pacific
  twitter: 1,     // Twitter rate windows are 15 min, but quota errors deserve longer
  linkedin: 24,   // LinkedIn daily limits
  meta: 1,        // Meta hourly windows
  instagram: 1,
  'google-analytics': 24,
  shopify: 0.05,  // Shopify is leaky-bucket, very short cooldown (3 min)
}
const DEFAULT_COOLDOWN_HOURS = 1

// Soft daily call budget per platform. We don't fail when we exceed it,
// but it shows up in /api/v1/quota so we can see what's pressing limits.
const DAILY_BUDGET: Record<string, number> = {
  youtube: 100,           // unit cost varies; we count requests not units
  twitter: 100,
  linkedin: 100,
  meta: 200,
  instagram: 200,
  'google-analytics': 50,
  shopify: 1000,
}

export interface QuotaCheck {
  allowed: boolean
  reason?: string
  retryAt?: number
}

export interface QuotaStatus {
  platform: string
  callsLast24h: number
  errorsLast24h: number
  quotaErrorsLast24h: number
  inCooldown: boolean
  cooldownUntil: number | null
  lastErrorMessage: string | null
  dailyBudget: number | null
  budgetRemaining: number | null
}

export class QuotaCooldownError extends Error {
  readonly platform: string
  readonly retryAt: number
  constructor(platform: string, reason: string, retryAt: number) {
    super(`${platform} in cooldown until ${new Date(retryAt).toISOString()}: ${reason}`)
    this.platform = platform
    this.retryAt = retryAt
    this.name = 'QuotaCooldownError'
  }
}

function isQuotaError(status: number, body: string | undefined): boolean {
  if (status === 429) return true
  if (status === 403 && body) {
    const lc = body.toLowerCase()
    if (lc.includes('quota') || lc.includes('rate limit') || lc.includes('ratelimit')
        || lc.includes('too many') || lc.includes('user_rate_limit')) {
      return true
    }
  }
  return false
}

export function canCallApi(platform: string): QuotaCheck {
  try {
    const db = getDb()
    const row = db
      .prepare('SELECT cooldown_until, last_error_message FROM api_quota_state WHERE platform = ?')
      .get(platform) as { cooldown_until: number | null; last_error_message: string | null } | undefined
    if (!row || !row.cooldown_until) return { allowed: true }
    if (row.cooldown_until > Date.now()) {
      return {
        allowed: false,
        reason: row.last_error_message ?? 'in cooldown',
        retryAt: row.cooldown_until,
      }
    }
    return { allowed: true }
  } catch (err) {
    logger.warn({ err, platform }, 'canCallApi check failed; allowing call')
    return { allowed: true }
  }
}

export function recordApiCall(args: {
  platform: string
  endpoint?: string
  status: number
  errorBody?: string
  durationMs?: number
}): void {
  const { platform, endpoint, status, errorBody, durationMs } = args
  const quotaErr = isQuotaError(status, errorBody)
  try {
    const db = getDb()
    db.prepare(`
      INSERT INTO api_call_log (platform, endpoint, status_code, is_quota_error, error_message, duration_ms, called_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      platform,
      endpoint ?? null,
      status,
      quotaErr ? 1 : 0,
      errorBody ? errorBody.slice(0, 500) : null,
      durationMs ?? null,
      Date.now(),
    )

    if (quotaErr) {
      const cooldownHours = COOLDOWN_HOURS[platform] ?? DEFAULT_COOLDOWN_HOURS
      const cooldownUntil = Date.now() + cooldownHours * 60 * 60 * 1000
      db.prepare(`
        INSERT INTO api_quota_state (platform, daily_limit, last_quota_error_at, cooldown_until, last_error_message, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(platform) DO UPDATE SET
          last_quota_error_at = excluded.last_quota_error_at,
          cooldown_until = excluded.cooldown_until,
          last_error_message = excluded.last_error_message,
          updated_at = excluded.updated_at
      `).run(
        platform,
        DAILY_BUDGET[platform] ?? null,
        Date.now(),
        cooldownUntil,
        errorBody ? errorBody.slice(0, 200) : `HTTP ${status}`,
        Date.now(),
      )
      logger.warn({ platform, cooldownUntil: new Date(cooldownUntil).toISOString() }, 'Quota error detected, cooldown set')
    }
  } catch (err) {
    logger.error({ err, platform }, 'recordApiCall failed')
  }
}

// Wrapper around fetch() that enforces cooldowns and logs every call.
// Callers get the same Response object back. If the platform is in
// cooldown, throws QuotaCooldownError before making any network call.
export async function quotaFetch(
  platform: string,
  url: string,
  init?: RequestInit & { endpoint?: string }
): Promise<Response> {
  const check = canCallApi(platform)
  if (!check.allowed) {
    throw new QuotaCooldownError(platform, check.reason ?? 'cooldown', check.retryAt ?? 0)
  }
  const endpoint = init?.endpoint ?? new URL(url).pathname
  const start = Date.now()
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    recordApiCall({
      platform,
      endpoint,
      status: 0,
      errorBody: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    })
    throw err
  }
  const durationMs = Date.now() - start
  if (res.ok) {
    recordApiCall({ platform, endpoint, status: res.status, durationMs })
    return res
  }
  // Read body for quota detection but return a fresh clone to the caller
  const cloned = res.clone()
  let body = ''
  try { body = await cloned.text() } catch { /* ignore */ }
  recordApiCall({ platform, endpoint, status: res.status, errorBody: body, durationMs })
  return res
}

export function getQuotaStatus(platform?: string): QuotaStatus[] {
  const db = getDb()
  const since = Date.now() - 24 * 60 * 60 * 1000

  // Discover all platforms we know about: union of logged calls + cooldown state
  let platformList: string[]
  if (platform) {
    platformList = [platform]
  } else {
    const rows = db.prepare(`
      SELECT platform FROM api_call_log WHERE called_at >= ?
      UNION
      SELECT platform FROM api_quota_state
    `).all(since) as { platform: string }[]
    platformList = rows.map(r => r.platform).sort()
  }

  return platformList.map(p => {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status_code >= 400 OR status_code = 0 THEN 1 ELSE 0 END) as errors,
        SUM(is_quota_error) as quota_errors
      FROM api_call_log
      WHERE platform = ? AND called_at >= ?
    `).get(p, since) as { total: number; errors: number; quota_errors: number }

    const state = db.prepare(`
      SELECT cooldown_until, last_error_message FROM api_quota_state WHERE platform = ?
    `).get(p) as { cooldown_until: number | null; last_error_message: string | null } | undefined

    const cooldownUntil = state?.cooldown_until ?? null
    const inCooldown = cooldownUntil !== null && cooldownUntil > Date.now()
    const budget = DAILY_BUDGET[p] ?? null
    const remaining = budget !== null ? Math.max(0, budget - (stats?.total ?? 0)) : null

    return {
      platform: p,
      callsLast24h: stats?.total ?? 0,
      errorsLast24h: stats?.errors ?? 0,
      quotaErrorsLast24h: stats?.quota_errors ?? 0,
      inCooldown,
      cooldownUntil: inCooldown ? cooldownUntil : null,
      lastErrorMessage: state?.last_error_message ?? null,
      dailyBudget: budget,
      budgetRemaining: remaining,
    }
  })
}

// Manually clear a cooldown (e.g., from dashboard "retry now" button)
export function clearCooldown(platform: string): void {
  try {
    const db = getDb()
    db.prepare('UPDATE api_quota_state SET cooldown_until = NULL, updated_at = ? WHERE platform = ?')
      .run(Date.now(), platform)
  } catch (err) {
    logger.error({ err, platform }, 'clearCooldown failed')
  }
}
