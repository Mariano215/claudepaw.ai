/**
 * Event sync module -- centralises POST to Hostinger server + retry queue.
 *
 * Instead of fire-and-forget fetch calls scattered across scheduler/pipeline,
 * every runAgent() result routes through postEventToServer(). On failure the
 * event_id is queued; a background loop retries unsynced events every 5 min.
 *
 * Backfill: on startup, all local events not already in the queue are seeded
 * in (INSERT OR IGNORE), so a freshly-wiped server DB catches up automatically.
 */

import { getTelemetryDb } from './telemetry-db.js'
import { DASHBOARD_URL, BOT_API_TOKEN } from './config.js'
import { logger } from './logger.js'

const RETRY_INTERVAL_MS = 5 * 60 * 1000   // 5 minutes
const BATCH_SIZE        = 50               // events per retry pass
const MAX_RETRIES       = 10               // drop from queue after this many failures

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function enqueue(eventId: string): void {
  try {
    getTelemetryDb()
      .prepare(`
        INSERT OR IGNORE INTO event_sync_queue (event_id, queued_at)
        VALUES (?, ?)
      `)
      .run(eventId, Date.now())
  } catch (err) {
    logger.warn({ err, eventId }, 'event-sync: failed to enqueue event')
  }
}

function dequeue(eventId: string): void {
  try {
    getTelemetryDb()
      .prepare('DELETE FROM event_sync_queue WHERE event_id = ?')
      .run(eventId)
  } catch (err) {
    logger.warn({ err, eventId }, 'event-sync: failed to dequeue event')
  }
}

function incrementRetry(eventId: string): void {
  try {
    getTelemetryDb()
      .prepare(`
        UPDATE event_sync_queue
        SET retry_count = retry_count + 1, last_attempt_at = ?
        WHERE event_id = ?
      `)
      .run(Date.now(), eventId)
  } catch (err) {
    logger.warn({ err, eventId }, 'event-sync: failed to increment retry count')
  }
}

async function postRow(row: Record<string, unknown>): Promise<boolean> {
  if (!DASHBOARD_URL) return true // no server configured; treat as success

  try {
    const res = await fetch(`${DASHBOARD_URL}/api/v1/chat/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(BOT_API_TOKEN ? { 'x-dashboard-token': BOT_API_TOKEN } : {}),
      },
      body: JSON.stringify(row),
    })
    // 2xx or 409 (INSERT OR IGNORE hit a dupe) both mean the server has the row
    return res.ok || res.status === 409
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Post an event row to the Hostinger server. On failure, enqueue for retry.
 * Call this instead of raw fetch() in scheduler / pipeline / paws paths.
 */
export async function postEventToServer(
  row: Record<string, unknown>,
): Promise<void> {
  const eventId = row.event_id as string | undefined
  if (!eventId) return

  const ok = await postRow(row)
  if (ok) {
    dequeue(eventId) // idempotent -- no-op if not queued
  } else {
    logger.warn({ eventId }, 'event-sync: POST failed; queued for retry')
    enqueue(eventId)
  }
}

/**
 * Retry pass: fetch a batch of queued event_ids, rebuild their rows from
 * the local telemetry DB, and POST. Successful rows are dequeued; failed
 * rows have their retry counter bumped. Events that hit MAX_RETRIES are
 * dropped to prevent unbounded queue growth.
 */
export async function retryUnsyncedEvents(): Promise<void> {
  if (!DASHBOARD_URL) return

  const d = getTelemetryDb()

  // Prune hopeless entries first
  d.prepare(
    'DELETE FROM event_sync_queue WHERE retry_count >= ?',
  ).run(MAX_RETRIES)

  type QueueRow = { event_id: string }
  const queued = d
    .prepare(
      `SELECT event_id FROM event_sync_queue
       ORDER BY queued_at ASC
       LIMIT ?`,
    )
    .all(BATCH_SIZE) as QueueRow[]

  if (queued.length === 0) return

  logger.info({ count: queued.length }, 'event-sync: retrying queued events')

  const eventStmt = d.prepare(`
    SELECT
      event_id, project_id, chat_id, session_id,
      received_at, memory_injected_at, agent_started_at, agent_ended_at, response_sent_at,
      prompt_summary, result_summary, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      total_cost_usd, duration_ms, duration_api_ms, num_turns, is_error,
      source, model_usage_json, prompt_text, result_text, agent_id,
      requested_provider, executed_provider, provider_fallback_applied
    FROM agent_events
    WHERE event_id = ?
  `)

  const toolStmt = d.prepare(`
    SELECT tool_use_id, tool_name, parent_tool_use_id, elapsed_seconds,
           started_at, duration_ms, tool_input_summary, success, error
    FROM tool_calls
    WHERE event_id = ?
  `)

  let synced = 0
  let failed = 0

  for (const { event_id } of queued) {
    const event = eventStmt.get(event_id) as Record<string, unknown> | undefined
    if (!event) {
      // event_id missing from local DB (shouldn't happen); remove from queue
      dequeue(event_id)
      continue
    }

    const toolCalls = toolStmt.all(event_id) as Record<string, unknown>[]
    const row = { ...event, tool_calls: toolCalls }

    const ok = await postRow(row)
    if (ok) {
      dequeue(event_id)
      synced++
    } else {
      incrementRetry(event_id)
      failed++
    }
  }

  if (synced > 0 || failed > 0) {
    logger.info({ synced, failed }, 'event-sync: retry pass complete')
  }
}

/**
 * Seed the sync queue with every local event_id not already queued.
 * Runs once at startup so a wiped/empty server DB catches up automatically.
 */
export function seedSyncQueue(): void {
  try {
    const d = getTelemetryDb()
    const { changes } = d
      .prepare(`
        INSERT OR IGNORE INTO event_sync_queue (event_id, queued_at)
        SELECT event_id, ? FROM agent_events
      `)
      .run(Date.now()) as { changes: number }

    if (changes > 0) {
      logger.info({ seeded: changes }, 'event-sync: seeded sync queue with unsynced events')
    }
  } catch (err) {
    logger.warn({ err }, 'event-sync: seed pass failed')
  }
}

/**
 * Start the background retry loop.
 * Call once from index.ts after telemetry DB is initialised.
 */
export function startEventSyncRetry(): void {
  // Seed queue with any events the server might be missing
  seedSyncQueue()

  // First retry pass after 30s (let the bot finish startup)
  setTimeout(() => {
    retryUnsyncedEvents().catch((err) =>
      logger.warn({ err }, 'event-sync: initial retry pass failed'),
    )
  }, 30_000)

  setInterval(() => {
    retryUnsyncedEvents().catch((err) =>
      logger.warn({ err }, 'event-sync: periodic retry pass failed'),
    )
  }, RETRY_INTERVAL_MS)

  logger.info('event-sync: retry loop started (5 min interval)')
}
