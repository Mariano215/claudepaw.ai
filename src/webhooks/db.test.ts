import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  initWebhookDb,
  getActiveWebhooksForEvent,
  getAllWebhooks,
  getWebhook,
  createWebhook,
  deleteWebhook,
  toggleWebhook,
  recordDelivery,
  getRecentDeliveries,
  getDeliveriesForWebhook,
  pruneDeliveries,
} from './db.js'
import { WebhookEvent } from './types.js'

function mkWebhook(overrides: Partial<any> = {}) {
  return {
    id: `wh-${Math.random().toString(36).slice(2, 10)}`,
    project_id: 'default',
    event_type: WebhookEvent.AgentCompleted,
    target_url: 'https://example.com/hook',
    secret: 'shh',
    active: 1,
    created_at: Date.now(),
    ...overrides,
  }
}

describe('webhooks db', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initWebhookDb(db)
  })
  afterEach(() => { db.close() })

  it('createWebhook + getWebhook round-trip', () => {
    const wh = mkWebhook()
    createWebhook(wh)
    const fetched = getWebhook(wh.id)
    expect(fetched?.target_url).toBe(wh.target_url)
  })

  it('getActiveWebhooksForEvent returns only active + matching project + event', () => {
    createWebhook(mkWebhook({ id: 'a', project_id: 'default', event_type: WebhookEvent.AgentCompleted }))
    createWebhook(mkWebhook({ id: 'b', project_id: 'example-company', event_type: WebhookEvent.AgentCompleted }))
    createWebhook(mkWebhook({ id: 'c', project_id: 'default', event_type: WebhookEvent.TaskCompleted }))
    createWebhook(mkWebhook({ id: 'd', project_id: 'default', event_type: WebhookEvent.AgentCompleted, active: 0 }))

    const results = getActiveWebhooksForEvent(WebhookEvent.AgentCompleted, 'default')
    expect(results.map(r => r.id)).toEqual(['a'])
  })

  it('toggleWebhook flips active flag', () => {
    const wh = mkWebhook({ active: 1 })
    createWebhook(wh)
    expect(toggleWebhook(wh.id, false)).toBe(true)
    expect(getWebhook(wh.id)?.active).toBe(0)
    expect(toggleWebhook(wh.id, true)).toBe(true)
    expect(getWebhook(wh.id)?.active).toBe(1)
  })

  it('toggleWebhook returns false when id missing', () => {
    expect(toggleWebhook('missing', true)).toBe(false)
  })

  it('deleteWebhook removes the row and returns true, false on missing', () => {
    const wh = mkWebhook()
    createWebhook(wh)
    expect(deleteWebhook(wh.id)).toBe(true)
    expect(getWebhook(wh.id)).toBeUndefined()
    expect(deleteWebhook(wh.id)).toBe(false)
  })

  it('recordDelivery + getRecentDeliveries orders newest first', () => {
    const wh = mkWebhook()
    createWebhook(wh)
    const base = Date.now()
    for (let i = 0; i < 3; i++) {
      recordDelivery({
        id: `d${i}`, webhook_id: wh.id, event_type: wh.event_type,
        payload: '{}', status_code: 200, response_time_ms: 10, error: null,
        created_at: base + i * 100,
      } as any)
    }
    const recent = getRecentDeliveries(10)
    expect(recent.map(d => d.id)).toEqual(['d2', 'd1', 'd0'])
  })

  it('getDeliveriesForWebhook scopes to a single webhook', () => {
    createWebhook(mkWebhook({ id: 'wA' }))
    createWebhook(mkWebhook({ id: 'wB' }))
    recordDelivery({ id: 'x', webhook_id: 'wA', event_type: 'agent.completed', payload: '{}', status_code: 200, response_time_ms: 1, error: null, created_at: Date.now() } as any)
    recordDelivery({ id: 'y', webhook_id: 'wB', event_type: 'agent.completed', payload: '{}', status_code: 200, response_time_ms: 1, error: null, created_at: Date.now() } as any)
    const forA = getDeliveriesForWebhook('wA')
    expect(forA.map(d => d.id)).toEqual(['x'])
  })

  it('pruneDeliveries keeps only the last 500', () => {
    const wh = mkWebhook()
    createWebhook(wh)
    const base = Date.now()
    for (let i = 0; i < 600; i++) {
      recordDelivery({
        id: `d${i}`, webhook_id: wh.id, event_type: wh.event_type,
        payload: '{}', status_code: 200, response_time_ms: 1, error: null,
        created_at: base + i,
      } as any)
    }
    pruneDeliveries()
    const remaining = db.prepare('SELECT COUNT(*) as n FROM webhook_deliveries').get() as { n: number }
    expect(remaining.n).toBe(500)
  })

  it('getAllWebhooks returns all, newest first', () => {
    createWebhook(mkWebhook({ id: 'old', created_at: 1000 }))
    createWebhook(mkWebhook({ id: 'new', created_at: 2000 }))
    const all = getAllWebhooks()
    expect(all[0].id).toBe('new')
  })
})
