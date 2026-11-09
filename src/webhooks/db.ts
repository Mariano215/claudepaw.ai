// src/webhooks/db.ts -- Webhook persistence (bot-side DB)

import type Database from 'better-sqlite3'
import { logger } from '../logger.js'
import type { WebhookRow, WebhookDeliveryRow, WebhookEvent } from './types.js'

// ---------------------------------------------------------------------------
// Database singleton (uses bot DB)
// ---------------------------------------------------------------------------

let db: Database.Database | null = null

export function initWebhookDb(parentDb: Database.Database): void {
  db = parentDb

  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL DEFAULT 'claudepaw',
      event_type  TEXT NOT NULL,
      target_url  TEXT NOT NULL,
      secret      TEXT NOT NULL DEFAULT '',
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_event ON webhooks(event_type, active);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id              TEXT PRIMARY KEY,
      webhook_id      TEXT NOT NULL,
      event_type      TEXT NOT NULL,
      payload         TEXT NOT NULL DEFAULT '{}',
      status_code     INTEGER,
      response_time_ms INTEGER,
      error           TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deliveries_created ON webhook_deliveries(created_at DESC);
  `)

  logger.info('Webhook tables initialized')
}

function getDb(): Database.Database {
  if (!db) throw new Error('Webhook DB not initialized -- call initWebhookDb first')
  return db
}

// ---------------------------------------------------------------------------
// Webhooks CRUD
// ---------------------------------------------------------------------------

export function getActiveWebhooksForEvent(event: WebhookEvent, projectId: string): WebhookRow[] {
  return getDb()
    .prepare('SELECT * FROM webhooks WHERE event_type = ? AND project_id = ? AND active = 1')
    .all(event, projectId) as WebhookRow[]
}

export function getAllWebhooks(): WebhookRow[] {
  return getDb()
    .prepare('SELECT * FROM webhooks ORDER BY created_at DESC')
    .all() as WebhookRow[]
}

export function getWebhook(id: string): WebhookRow | undefined {
  return getDb()
    .prepare('SELECT * FROM webhooks WHERE id = ?')
    .get(id) as WebhookRow | undefined
}

export function createWebhook(webhook: WebhookRow): void {
  getDb().prepare(`
    INSERT INTO webhooks (id, project_id, event_type, target_url, secret, active, created_at)
    VALUES (@id, @project_id, @event_type, @target_url, @secret, @active, @created_at)
  `).run(webhook)
}

export function deleteWebhook(id: string): boolean {
  const result = getDb().prepare('DELETE FROM webhooks WHERE id = ?').run(id)
  return result.changes > 0
}

export function toggleWebhook(id: string, active: boolean): boolean {
  const result = getDb()
    .prepare('UPDATE webhooks SET active = ? WHERE id = ?')
    .run(active ? 1 : 0, id)
  return result.changes > 0
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export function recordDelivery(delivery: WebhookDeliveryRow): void {
  getDb().prepare(`
    INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status_code, response_time_ms, error, created_at)
    VALUES (@id, @webhook_id, @event_type, @payload, @status_code, @response_time_ms, @error, @created_at)
  `).run(delivery)
}

export function getRecentDeliveries(limit = 50): WebhookDeliveryRow[] {
  return getDb()
    .prepare('SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?')
    .all(limit) as WebhookDeliveryRow[]
}

export function getDeliveriesForWebhook(webhookId: string, limit = 20): WebhookDeliveryRow[] {
  return getDb()
    .prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(webhookId, limit) as WebhookDeliveryRow[]
}

/** Prune old deliveries (keep last 500) */
export function pruneDeliveries(): void {
  getDb().exec(`
    DELETE FROM webhook_deliveries WHERE id NOT IN (
      SELECT id FROM webhook_deliveries ORDER BY created_at DESC LIMIT 500
    )
  `)
}
