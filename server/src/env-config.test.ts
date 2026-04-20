/**
 * env-config.test.ts
 *
 * Phase 7 Task 8 -- unit tests for resolveKillSwitchLogRetentionDays.
 *
 * The parser sits between `process.env.KILL_SWITCH_LOG_RETENTION_DAYS`
 * and the daily prune job in index.ts.  A typo in the env must not
 * silently disable retention, so anything malformed has to fall back
 * to the 180-day default AND warn so ops can spot it in the logs.
 *
 * The logger is injected for test visibility -- we assert the warn
 * call rather than grepping real pino output.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  resolveKillSwitchLogRetentionDays,
  KILL_SWITCH_LOG_RETENTION_DEFAULT_DAYS,
} from './env-config.js'

// Typed loosely on purpose -- the parser only calls logger.warn once
// with a context object + message, and vi.fn()'s generic Mock type
// does not satisfy the stricter WarnLogger signature without a cast.
// Exporting the mock as WarnLogger via an any-cast keeps the test
// noise down without widening the parser's real interface.
function mockLogger(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() }
}
function asLogger(m: { warn: ReturnType<typeof vi.fn> }): Parameters<typeof resolveKillSwitchLogRetentionDays>[1] {
  return m as unknown as Parameters<typeof resolveKillSwitchLogRetentionDays>[1]
}

describe('resolveKillSwitchLogRetentionDays (Phase 7 Task 8)', () => {
  it('returns the 180-day default when the env var is undefined', () => {
    const logger = mockLogger()
    const days = resolveKillSwitchLogRetentionDays(undefined, asLogger(logger))
    expect(days).toBe(KILL_SWITCH_LOG_RETENTION_DEFAULT_DAYS)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('returns the default and does not warn on an empty string', () => {
    const logger = mockLogger()
    const days = resolveKillSwitchLogRetentionDays('', asLogger(logger))
    expect(days).toBe(KILL_SWITCH_LOG_RETENTION_DEFAULT_DAYS)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('parses a valid positive integer string', () => {
    const logger = mockLogger()
    expect(resolveKillSwitchLogRetentionDays('30', asLogger(logger))).toBe(30)
    expect(resolveKillSwitchLogRetentionDays('365', asLogger(logger))).toBe(365)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('falls back to default and warns on a non-numeric value', () => {
    const logger = mockLogger()
    const days = resolveKillSwitchLogRetentionDays('forever', asLogger(logger))
    expect(days).toBe(KILL_SWITCH_LOG_RETENTION_DEFAULT_DAYS)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toMatchObject({
      raw: 'forever',
      fallback: KILL_SWITCH_LOG_RETENTION_DEFAULT_DAYS,
    })
  })

  it('falls back to default and warns on a non-integer value (floats reject)', () => {
    const logger = mockLogger()
    const days = resolveKillSwitchLogRetentionDays('1.5', asLogger(logger))
    expect(days).toBe(KILL_SWITCH_LOG_RETENTION_DEFAULT_DAYS)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('falls back to default and warns on zero or negative', () => {
    const loggerZero = mockLogger()
    expect(resolveKillSwitchLogRetentionDays('0', asLogger(loggerZero))).toBe(
      KILL_SWITCH_LOG_RETENTION_DEFAULT_DAYS,
    )
    expect(loggerZero.warn).toHaveBeenCalledTimes(1)

    const loggerNeg = mockLogger()
    expect(resolveKillSwitchLogRetentionDays('-10', asLogger(loggerNeg))).toBe(
      KILL_SWITCH_LOG_RETENTION_DEFAULT_DAYS,
    )
    expect(loggerNeg.warn).toHaveBeenCalledTimes(1)
  })
})
