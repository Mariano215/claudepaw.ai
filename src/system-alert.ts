/**
 * Break-glass system alerts.
 *
 * THREAT MODEL / GATE EXCEPTION (operator-approved 2026-06-11): this module
 * deliberately bypasses ChannelManager and its kill-switch gate. During the
 * Jun 8-11 2026 dashboard outage the kill switch failed closed AND blocked
 * every Telegram send, so the one component that could have reported the
 * outage was silenced by it -- a 3-day silent failure.
 *
 * Constraints that keep this safe:
 *   - Messages are HARDCODED system strings composed in this codebase only.
 *     NEVER route agent/LLM output, user content, or interpolated remote data
 *     through sendSystemAlert.
 *   - Only the operator chat (ALLOWED_CHAT_ID) can be addressed. No dynamic
 *     chat ids.
 *   - Rate-limited to one alert per key per hour, so a flapping condition
 *     cannot flood the channel.
 *   - Plain text only (no parse_mode), matching the channel hard rule.
 *
 * Use ONLY for system-health conditions that the normal (gated) send path
 * cannot deliver: dashboard unreachable, kill-switch state transitions,
 * pipeline stalls.
 */
import { BOT_TOKEN, ALLOWED_CHAT_ID } from './config.js'
import { logger } from './logger.js'

const RATE_LIMIT_MS = 60 * 60 * 1000 // one alert per key per hour
const lastSentByKey = new Map<string, number>()

/** Test hook: clear the rate limiter. */
export function _resetSystemAlertState(): void {
  lastSentByKey.clear()
}

/**
 * Send a plain-text system alert directly to the operator chat via the
 * Telegram Bot API. Fire-and-forget: failures are logged, never thrown --
 * an alerting failure must not take down the caller.
 *
 * Returns true when a message was actually sent (false when rate-limited,
 * unconfigured, or the HTTP call failed).
 */
export async function sendSystemAlert(key: string, text: string): Promise<boolean> {
  try {
    if (!BOT_TOKEN || !ALLOWED_CHAT_ID) return false

    const now = Date.now()
    const last = lastSentByKey.get(key) ?? 0
    if (now - last < RATE_LIMIT_MS) return false
    lastSentByKey.set(key, now)

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Plain text on purpose -- no parse_mode, ever (channel hard rule).
      body: JSON.stringify({ chat_id: ALLOWED_CHAT_ID, text: `SYSTEM ALERT: ${text}` }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      logger.warn({ key, status: res.status }, 'system-alert: Telegram send failed')
      return false
    }
    logger.warn({ key }, 'system-alert: sent')
    return true
  } catch (err) {
    logger.warn({ err, key }, 'system-alert: send threw')
    return false
  }
}
