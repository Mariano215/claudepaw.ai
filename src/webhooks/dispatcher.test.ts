import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'

const webhooksStore: any[] = []
const deliveries: any[] = []

vi.mock('./db.js', () => ({
  getActiveWebhooksForEvent: vi.fn(() => webhooksStore),
  recordDelivery: vi.fn((d: any) => { deliveries.push(d) }),
  pruneDeliveries: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { WebhookEvent } from './types.js'
import {
  fireWebhook,
  fireAgentCompleted,
  fireSecurityFinding,
  fireTaskCompleted,
  fireGuardBlocked,
  startPruneTimer,
  stopPruneTimer,
} from './dispatcher.js'
import { getActiveWebhooksForEvent, recordDelivery, pruneDeliveries } from './db.js'
import { logger } from '../logger.js'

describe('webhook dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    webhooksStore.length = 0
    deliveries.length = 0
    // startPruneTimer is module-scoped; reset between tests so each starts
    // with a clean timer slate. Without this, a test that calls startPruneTimer
    // leaves the timer running for every subsequent test.
    stopPruneTimer()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => '',
    })))
  })

  it('queries active webhooks with the event and owning project id', async () => {
    await fireWebhook(WebhookEvent.AgentCompleted, { ok: true }, 'example-company')
    expect(getActiveWebhooksForEvent).toHaveBeenCalledWith(WebhookEvent.AgentCompleted, 'example-company')
  })

  it('returns silently when DB throws (boot state)', async () => {
    ;(getActiveWebhooksForEvent as any).mockImplementationOnce(() => { throw new Error('db not ready') })
    await expect(fireWebhook(WebhookEvent.AgentCompleted, {}, 'default')).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('no-ops when no webhooks are registered for the event', async () => {
    await fireWebhook(WebhookEvent.AgentCompleted, {}, 'default')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('signs payload with HMAC SHA-256 when secret is set', async () => {
    webhooksStore.push({
      id: 'wh1', project_id: 'default', event_type: WebhookEvent.AgentCompleted,
      target_url: 'https://example.com/hook', secret: 'sekret', active: 1, created_at: Date.now(),
    })
    await fireWebhook(WebhookEvent.AgentCompleted, { foo: 'bar' }, 'default')
    await new Promise(r => setTimeout(r, 5))
    const call = (fetch as any).mock.calls[0]
    const headers = call[1].headers as Record<string, string>
    const sig = headers['X-ClaudePaw-Signature']
    expect(sig).toBeDefined()
    const body = call[1].body as string
    const expected = createHmac('sha256', 'sekret').update(body).digest('hex')
    expect(sig).toBe(expected)
  })

  it('HMAC rejects tampered payload (sig computed from wrong bytes no longer matches)', async () => {
    webhooksStore.push({
      id: 'wh1b', project_id: 'default', event_type: WebhookEvent.AgentCompleted,
      target_url: 'https://example.com/hook', secret: 'sekret', active: 1, created_at: Date.now(),
    })
    await fireWebhook(WebhookEvent.AgentCompleted, { foo: 'bar' }, 'default')
    await new Promise(r => setTimeout(r, 5))
    const call = (fetch as any).mock.calls[0]
    const sig = (call[1].headers as Record<string, string>)['X-ClaudePaw-Signature']
    const body = call[1].body as string
    const tamperedBody = body.replace('"foo":"bar"', '"foo":"attacker"')
    const tamperedSig = createHmac('sha256', 'sekret').update(tamperedBody).digest('hex')
    // A receiver recomputing HMAC over tampered bytes would get a different digest.
    expect(tamperedSig).not.toBe(sig)
    // Wrong-secret attack: same body, different secret, different digest.
    const wrongSecret = createHmac('sha256', 'other').update(body).digest('hex')
    expect(wrongSecret).not.toBe(sig)
  })

  it('omits signature header when secret is empty', async () => {
    webhooksStore.push({
      id: 'wh2', project_id: 'default', event_type: WebhookEvent.AgentCompleted,
      target_url: 'https://example.com/hook', secret: '', active: 1, created_at: Date.now(),
    })
    await fireWebhook(WebhookEvent.AgentCompleted, {}, 'default')
    await new Promise(r => setTimeout(r, 5))
    const headers = (fetch as any).mock.calls[0][1].headers as Record<string, string>
    expect(headers['X-ClaudePaw-Signature']).toBeUndefined()
  })

  it('records delivery with status_code on success', async () => {
    webhooksStore.push({
      id: 'wh3', project_id: 'default', event_type: WebhookEvent.TaskCompleted,
      target_url: 'https://example.com/hook', secret: '', active: 1, created_at: Date.now(),
    })
    await fireWebhook(WebhookEvent.TaskCompleted, {}, 'default')
    await new Promise(r => setTimeout(r, 5))
    expect(recordDelivery).toHaveBeenCalled()
    const d = deliveries[0]
    expect(d.status_code).toBe(200)
    expect(d.error).toBeNull()
  })

  it('records delivery with error string on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    webhooksStore.push({
      id: 'wh4', project_id: 'default', event_type: WebhookEvent.TaskCompleted,
      target_url: 'https://example.com/hook', secret: '', active: 1, created_at: Date.now(),
    })
    await fireWebhook(WebhookEvent.TaskCompleted, {}, 'default')
    await new Promise(r => setTimeout(r, 5))
    const d = deliveries[0]
    expect(d.status_code).toBeNull()
    expect(d.error).toContain('ECONNREFUSED')
  })

  it('records delivery with abort error when fetch exceeds the 10s timeout', async () => {
    // fetch never resolves on its own; only the AbortController from the
    // dispatcher's setTimeout should short-circuit it.
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted')
          ;(err as any).name = 'AbortError'
          reject(err)
        })
      }),
    ))
    webhooksStore.push({
      id: 'wh-timeout', project_id: 'default', event_type: WebhookEvent.TaskCompleted,
      target_url: 'https://example.com/slow', secret: '', active: 1, created_at: Date.now(),
    })

    vi.useFakeTimers()
    try {
      const fired = fireWebhook(WebhookEvent.TaskCompleted, {}, 'default')
      // Advance past the 10s dispatcher timeout so the AbortController fires.
      await vi.advanceTimersByTimeAsync(11_000)
      await fired
      // Give the async delivery queue a tick to record.
      await vi.advanceTimersByTimeAsync(10)
    } finally {
      vi.useRealTimers()
    }

    expect(deliveries).toHaveLength(1)
    const d = deliveries[0]
    expect(d.status_code).toBeNull()
    expect(d.error).toMatch(/abort/i)
  })

  it('boot-state DB failure logs a warning (not silent)', async () => {
    ;(getActiveWebhooksForEvent as any).mockImplementationOnce(() => { throw new Error('no such table: webhooks') })
    await fireWebhook(WebhookEvent.AgentCompleted, {}, 'default')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: WebhookEvent.AgentCompleted, projectId: 'default' }),
      expect.stringContaining('Webhook dispatch skipped'),
    )
  })

  it('prune timer logs errors instead of swallowing them', () => {
    vi.useFakeTimers()
    try {
      ;(pruneDeliveries as any).mockImplementationOnce(() => { throw new Error('disk full') })
      startPruneTimer()
      // First tick triggers the throwing pruneDeliveries.
      vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 100)
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        expect.stringContaining('prune failed'),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('each convenience helper targets its own event type', async () => {
    fireAgentCompleted({ agent_id: 'a', task_preview: '', result_preview: '' })
    fireSecurityFinding({ finding_id: 'f', scanner_id: 's', severity: 'low', title: 't', target: 'x' })
    fireTaskCompleted({ task_id: 't', task_preview: '', result_preview: '', status: 'success' })
    fireGuardBlocked({ chat_id: 'c', triggered_layers: [], block_reason: null, phase: 'pre' })
    await new Promise(r => setTimeout(r, 5))
    const events = (getActiveWebhooksForEvent as any).mock.calls.map((c: any) => c[0])
    expect(events).toEqual([
      WebhookEvent.AgentCompleted,
      WebhookEvent.SecurityFinding,
      WebhookEvent.TaskCompleted,
      WebhookEvent.GuardBlocked,
    ])
  })

  it('convenience helper logs a warning instead of silently swallowing rejections', async () => {
    // Register a webhook so we hit the JSON.stringify call; BigInt is not
    // serializable by JSON.stringify, which throws synchronously inside the
    // async fireWebhook before the first internal try/catch, producing a
    // rejected promise that would have been silenced by the old
    // `.catch(() => {})`. The new onHelperReject path must log instead.
    webhooksStore.push({
      id: 'wh-reject', project_id: 'default', event_type: WebhookEvent.AgentCompleted,
      target_url: 'https://example.com/hook', secret: '', active: 1, created_at: Date.now(),
    })
    // data.duration_ms is typed `number`, but we need a BigInt somewhere; inject
    // via a loosely typed spread that bypasses the param shape at runtime.
    fireAgentCompleted({
      agent_id: 'a', task_preview: '', result_preview: '',
      ...(({ evil: 1n } as unknown) as { duration_ms: number }),
    })
    // The rejection from JSON.stringify happens after a microtask; flush.
    await new Promise(r => setTimeout(r, 5))
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: WebhookEvent.AgentCompleted, err: expect.any(Error) }),
      expect.stringContaining('convenience helper rejected'),
    )
  })

  it('startPruneTimer sets up a recurring prune (and does not double-start)', () => {
    vi.useFakeTimers()
    try {
      startPruneTimer()
      startPruneTimer()
      vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 100)
      expect(pruneDeliveries).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
