// src/guard/logger.ts
import { appendFileSync, existsSync, statSync, renameSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { logger as pinoLogger } from '../logger.js'
import type { GuardEvent } from './types.js'

const MAX_JSONL_BYTES = 10 * 1024 * 1024 // 10 MB
const MAX_BACKUPS = 5

export class GuardLogger {
  private db: Database.Database
  private jsonlPath: string
  private insertStmt: Database.Statement
  private pruneStmt: Database.Statement

  constructor(db: Database.Database, jsonlPath: string) {
    this.db = db
    this.jsonlPath = jsonlPath

    this.insertStmt = db.prepare(`
      INSERT INTO guard_events (id, timestamp, chat_id, event_type, triggered_layers, block_reason, original_message, sanitized_message, layer_results, latency_ms, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    this.pruneStmt = db.prepare(`
      DELETE FROM guard_events WHERE timestamp < ?
    `)
  }

  log(event: GuardEvent): void {
    // 1. Write to SQLite
    // For PASSED events, do not store message content
    const originalMsg = event.eventType === 'PASSED' ? null : event.originalMessage
    const sanitizedMsg = event.eventType === 'PASSED' ? null : event.sanitizedMessage

    try {
      this.insertStmt.run(
        event.id,
        event.timestamp,
        event.chatId,
        event.eventType,
        JSON.stringify(event.triggeredLayers),
        event.blockReason,
        originalMsg,
        sanitizedMsg,
        JSON.stringify(event.layerResults),
        event.latencyMs,
        event.requestId,
      )
    } catch (err) {
      pinoLogger.error({ err, eventId: event.id }, 'Failed to write guard event to SQLite')
    }

    // 2. Write to JSONL
    try {
      this.rotateIfNeeded()
      const jsonlEntry: Record<string, unknown> = {
        timestamp: new Date(event.timestamp).toISOString(),
        requestId: event.requestId,
        eventType: event.eventType,
        triggeredLayers: event.triggeredLayers,
        blockReason: event.blockReason,
        layerResults: event.layerResults,
        latencyMs: event.latencyMs,
      }
      // Only include message in JSONL for BLOCKED/FLAGGED
      if (event.eventType !== 'PASSED' && event.sanitizedMessage) {
        jsonlEntry.sanitizedMessage = event.sanitizedMessage
      }
      appendFileSync(this.jsonlPath, JSON.stringify(jsonlEntry) + '\n')
    } catch (err) {
      pinoLogger.error({ err, eventId: event.id }, 'Failed to write guard event to JSONL')
    }

    // 3. Write to pino logger
    const logData = {
      requestId: event.requestId,
      eventType: event.eventType,
      triggeredLayers: event.triggeredLayers,
      blockReason: event.blockReason,
      latencyMs: event.latencyMs,
    }

    if (event.eventType === 'BLOCKED') {
      pinoLogger.error(logData, 'Guard: message BLOCKED')
    } else if (event.eventType === 'FLAGGED') {
      pinoLogger.warn(logData, 'Guard: message FLAGGED')
    } else {
      pinoLogger.debug(logData, 'Guard: message passed')
    }
  }

  prune(retentionDays: number = 90): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const result = this.pruneStmt.run(cutoff)
    if (result.changes > 0) {
      pinoLogger.info({ pruned: result.changes }, 'Pruned old guard events')
    }
    return result.changes
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.jsonlPath)) return
    try {
      const stats = statSync(this.jsonlPath)
      if (stats.size < MAX_JSONL_BYTES) return

      // Rotate: shift backups down
      for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
        const from = `${this.jsonlPath}.${i}`
        const to = `${this.jsonlPath}.${i + 1}`
        if (existsSync(from)) {
          renameSync(from, to)
        }
      }
      renameSync(this.jsonlPath, `${this.jsonlPath}.1`)
    } catch {
      // Rotation failure is non-fatal
    }
  }
}
