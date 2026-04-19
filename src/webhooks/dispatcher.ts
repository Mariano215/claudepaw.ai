// src/webhooks/dispatcher.ts -- Fire HTTP POST to registered webhook URLs

import { createHmac, randomUUID } from 'node:crypto'
import { logger } from '../logger.js'
import { WebhookEvent, type WebhookPayload } from './types.js'
import {
  getActiveWebhooksForEvent,
  recordDelivery,
  pruneDeliveries,
} from './db.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 10_000
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

let pruneTimer: ReturnType<typeof setInterval> | null = null

export function startPruneTimer(): void {
  if (pruneTimer) return
  pruneTimer = setInterval(() => {
    try {
      pruneDeliveries()
    } catch (err) {
      // Previously silent. A persistent failure here lets webhook_deliveries
      // grow unbounded (disk full, DB locked, schema drift). Log so operators see it.
      logger.error({ err }, 'Webhook delivery prune failed')
    }
  }, PRUNE_INTERVAL_MS)
}

/**
 * Stop the prune timer. Safe to call when not started. Exposed primarily so
 * tests can reset module-scoped state between cases; production code has no
 * need to call this (the timer is meant to run for the process lifetime).
 */
export function stopPruneTimer(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer)
    pruneTimer = null
  }
}

// ---------------------------------------------------------------------------
// HMAC signing
// ---------------------------------------------------------------------------

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

// ---------------------------------------------------------------------------
// Fire a single webhook event
// ---------------------------------------------------------------------------

export async function fireWebhook(
  event: WebhookEvent,
  data: Record<string, unknown>,
  projectId = 'claudepaw',
): Promise<void> {
  let webhooks
  try {
    webhooks = getActiveWebhooksForEvent(event, projectId)
  } catch (err) {
    // Most common cause: DB not initialized yet during boot. Also covers real
    // failures (missing table, corrupt DB, schema drift). Log at warn so
    // operators see permanent misconfigurations instead of silent outages.
    logger.warn(
      { err, event, projectId },
      'Webhook dispatch skipped: failed to load active webhooks',
    )
    return
  }

  if (webhooks.length === 0) return

  const payload: WebhookPayload = {
    event,
    timestamp: Date.now(),
    project_id: projectId,
    data,
  }
  const body = JSON.stringify(payload)

  // Fire all webhooks concurrently, don't block caller
  const deliveries = webhooks.map(async (wh) => {
    const deliveryId = randomUUID()
    const startMs = Date.now()
    let statusCode: number | null = null
    let error: string | null = null

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-ClaudePaw-Event': event,
        'X-ClaudePaw-Delivery': deliveryId,
      }

      if (wh.secret) {
        headers['X-ClaudePaw-Signature'] = signPayload(body, wh.secret)
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

      try {
        const resp = await fetch(wh.target_url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        })
        statusCode = resp.status
      } finally {
        // Ensure the timer is cleared even on abort/exception so we don't leak
        // the timeout reference until GC.
        clearTimeout(timeout)
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      logger.warn({ webhookId: wh.id, event, error }, 'Webhook delivery failed')
    }

    const responseTimeMs = Date.now() - startMs

    try {
      recordDelivery({
        id: deliveryId,
        webhook_id: wh.id,
        event_type: event,
        payload: body,
        status_code: statusCode,
        response_time_ms: responseTimeMs,
        error,
        created_at: Date.now(),
      })
    } catch (dbErr) {
      logger.error({ dbErr, deliveryId }, 'Failed to record webhook delivery')
    }
  })

  // Don't await -- fire and forget so we don't slow down the pipeline.
  // allSettled never rejects, so no .catch tail is needed (previously had
  // a dead `.catch(() => {})` that masked nothing).
  void Promise.allSettled(deliveries)
}

// ---------------------------------------------------------------------------
// Convenience helpers for each event type
// ---------------------------------------------------------------------------

/**
 * Shared rejection handler for fire-and-forget helpers. Today fireWebhook
 * does not reject under any tested path -- its internal catches convert
 * errors to warn-logged returns. But the helpers must not swallow future
 * rejections (e.g. a JSON.stringify failure on a BigInt payload throwing
 * synchronously before the first internal try/catch). Log at warn so we see
 * them instead of losing them to detached-promise rejection tracking.
 */
function onHelperReject(event: WebhookEvent): (err: unknown) => void {
  return (err) => logger.warn({ err, event }, 'Webhook convenience helper rejected')
}

export function fireAgentCompleted(data: {
  agent_id: string
  task_preview: string
  result_preview: string
  duration_ms?: number
  source?: string
}, projectId = 'claudepaw'): void {
  fireWebhook(WebhookEvent.AgentCompleted, data, projectId)
    .catch(onHelperReject(WebhookEvent.AgentCompleted))
}

export function fireSecurityFinding(data: {
  finding_id: string
  scanner_id: string
  severity: string
  title: string
  target: string
}, projectId = 'claudepaw'): void {
  fireWebhook(WebhookEvent.SecurityFinding, data, projectId)
    .catch(onHelperReject(WebhookEvent.SecurityFinding))
}

export function fireTaskCompleted(data: {
  task_id: string
  task_preview: string
  result_preview: string
  status: 'success' | 'error'
}, projectId = 'claudepaw'): void {
  fireWebhook(WebhookEvent.TaskCompleted, data, projectId)
    .catch(onHelperReject(WebhookEvent.TaskCompleted))
}

export function fireGuardBlocked(data: {
  chat_id: string
  triggered_layers: string[]
  block_reason: string | null
  phase: 'pre' | 'post'
}, projectId = 'claudepaw'): void {
  fireWebhook(WebhookEvent.GuardBlocked, data, projectId)
    .catch(onHelperReject(WebhookEvent.GuardBlocked))
}
