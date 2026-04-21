// src/retention.ts
// Purges old rows from telemetry.db to keep the file bounded. Runs every 6h
// from src/index.ts. Retention defaults to 180 days, override via
// AGENT_EVENTS_RETENTION_DAYS env var.

import { getTelemetryDb } from './telemetry-db.js'
import { logger } from './logger.js'
import { readEnvFile } from './env.js'

const DEFAULT_RETENTION_DAYS = 180

function resolveRetentionDays(): number {
  const env = readEnvFile()
  const raw = Number(env.AGENT_EVENTS_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RETENTION_DAYS
  return Math.round(raw)
}

export function purgeOldAgentEvents(): { deleted: number; retentionDays: number } {
  const retentionDays = resolveRetentionDays()
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const db = getTelemetryDb()
  const result = db.prepare(
    `DELETE FROM agent_events WHERE received_at < ?`,
  ).run(cutoff)
  const deleted = Number(result.changes ?? 0)
  if (deleted > 0) {
    logger.info(
      { deleted, retentionDays, cutoff },
      '[retention] Purged old agent_events',
    )
    // Reclaim disk after a large purge.
    try {
      db.pragma('wal_checkpoint(TRUNCATE)')
    } catch (err) {
      logger.debug({ err }, '[retention] wal_checkpoint failed')
    }
  }
  return { deleted, retentionDays }
}

/**
 * Install a 6h interval that purges old events. Safe to call once at startup.
 * Returns a teardown function for clean shutdown.
 */
export function startRetentionJob(): () => void {
  // Run once shortly after startup so the daily report reflects any purged rows.
  const bootTimer = setTimeout(() => {
    try {
      purgeOldAgentEvents()
    } catch (err) {
      logger.error({ err }, '[retention] boot purge failed')
    }
  }, 60_000)

  const interval = setInterval(() => {
    try {
      purgeOldAgentEvents()
    } catch (err) {
      logger.error({ err }, '[retention] scheduled purge failed')
    }
  }, 6 * 60 * 60 * 1000)

  return () => {
    clearTimeout(bootTimer)
    clearInterval(interval)
  }
}
