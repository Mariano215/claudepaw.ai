/**
 * env-config.ts
 *
 * Tiny home for env-var parsing helpers that need to be shared across
 * server modules AND reached from tests.  index.ts boots the HTTP server
 * as a side effect of being imported, so parsers that live only inside
 * it cannot be imported into a unit test without spinning up the whole
 * process.  Anything that should be exercised in isolation belongs
 * here.
 *
 * Phase 7 Task 8 -- introduced for KILL_SWITCH_LOG_RETENTION_DAYS.
 */

export const KILL_SWITCH_LOG_RETENTION_DEFAULT_DAYS = 180

/**
 * Minimal logger shape the parser needs.  Kept narrow so tests can
 * pass a bare `{ warn: vi.fn() }` without pulling in pino's overload
 * gymnastics, and so any future caller can wire in whatever structured
 * logger they already have on hand.
 */
export interface WarnLogger {
  warn: (...args: unknown[]) => void
}

/**
 * Resolve the kill_switch_log retention window (in days) from the
 * KILL_SWITCH_LOG_RETENTION_DAYS env var, falling back to the 180-day
 * default on anything malformed.  A non-numeric, non-finite, non-
 * integer, or non-positive value logs a warning and uses the default
 * so a typo in the env cannot silently disable retention.
 *
 * The logger argument is injected so tests can assert on warnings
 * without capturing pino output off the real server logger.
 */
export function resolveKillSwitchLogRetentionDays(
  raw: string | undefined,
  logger: WarnLogger,
): number {
  if (raw === undefined || raw === '') return KILL_SWITCH_LOG_RETENTION_DEFAULT_DAYS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    logger.warn(
      { raw, fallback: KILL_SWITCH_LOG_RETENTION_DEFAULT_DAYS },
      'KILL_SWITCH_LOG_RETENTION_DAYS must be a positive integer; using default',
    )
    return KILL_SWITCH_LOG_RETENTION_DEFAULT_DAYS
  }
  return parsed
}
