// The collector observer hook exists so project subsystems can record their own
// telemetry without the generic paws engine importing them. src/paws/engine.ts
// previously imported src/trader/operational-events.js and branched on a
// hardcoded project id.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerCollector,
  registerCollectorObserver,
  runCollector,
  type CollectorObservation,
} from './index.js'

const seen: CollectorObservation[] = []

beforeEach(() => {
  seen.length = 0
})

registerCollectorObserver((obs) => { seen.push(obs) })

registerCollector('test-observer-ok', async () => ({
  raw_data: { fine: true },
  collected_at: Date.now(),
  collector: 'test-observer-ok',
}))

registerCollector('test-observer-soft-errors', async () => ({
  raw_data: null,
  collected_at: Date.now(),
  collector: 'test-observer-soft-errors',
  errors: ['gh rate limited', 'discussions disabled'],
}))

registerCollector('test-observer-throws', async () => {
  throw new Error('boom')
})

describe('collector observers', () => {
  it('reports a successful run with zero errors', async () => {
    await runCollector('test-observer-ok', { pawId: 'p1', projectId: 'trader' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      collector: 'test-observer-ok',
      pawId: 'p1',
      projectId: 'trader',
      errorCount: 0,
      threw: false,
    })
    expect(seen[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  it('reports the error count for a run that returned soft errors', async () => {
    await runCollector('test-observer-soft-errors', { pawId: 'p2', projectId: 'broker' })
    expect(seen[0]).toMatchObject({ errorCount: 2, threw: false })
  })

  it('reports a run that threw, so a hard failure is still observable', async () => {
    const result = await runCollector('test-observer-throws', { pawId: 'p3', projectId: 'dev' })
    expect(seen[0]).toMatchObject({ collector: 'test-observer-throws', threw: true, errorCount: 1 })
    // runCollector still must not throw.
    expect(result.errors?.[0]).toContain('boom')
  })

  it('does not let a broken observer break data collection', async () => {
    registerCollectorObserver(() => { throw new Error('observer exploded') })
    const result = await runCollector('test-observer-ok', { pawId: 'p4', projectId: 'trader' })
    expect(result.raw_data).toEqual({ fine: true })
  })
})
