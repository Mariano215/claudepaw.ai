// src/remediations/__tests__/runner.test.ts
// Exercises the remediation runner against an in-memory sqlite DB.
// Each test installs its own fake remediation into the registry, verifies
// the runner logs outcomes, isolates throws from other rules, and records
// acted / noop counts correctly.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `claudepaw-remediations-runner-test-${process.pid}`)

vi.mock('../../config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const dir = path.join(os.tmpdir(), `claudepaw-remediations-runner-test-${process.pid}`)
  return { STORE_DIR: dir, PROJECT_ROOT: dir, DASHBOARD_URL: '', DASHBOARD_API_TOKEN: '', BOT_API_TOKEN: '' }
})

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { initDatabase } from '../../db.js'
import { initRemediationsSchema, recentRemediations } from '../db.js'
import { runAllRemediations } from '../runner.js'
import { registerRemediation, listRemediations } from '../registry.js'
import type { RemediationDefinition } from '../types.js'

function fakeRemediation(id: string, fn: RemediationDefinition['run']): RemediationDefinition {
  return {
    id,
    name: id,
    tier: 'auto-safe',
    description: 'test',
    run: fn,
  }
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  initDatabase()
  initRemediationsSchema()
})

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('runAllRemediations', () => {
  it('records acted rows and not noop rows by default', async () => {
    registerRemediation(fakeRemediation('test-acted', async () => ({ acted: true, summary: 'did work' })))
    registerRemediation(fakeRemediation('test-noop', async () => ({ acted: false, summary: 'idle' })))

    const result = await runAllRemediations()

    expect(result.failed).toEqual([])
    expect(result.acted).toContain('test-acted')
    expect(result.noop).toContain('test-noop')

    const rows = recentRemediations()
    expect(rows.some((r) => r.remediation_id === 'test-acted' && r.acted === 1)).toBe(true)
    expect(rows.some((r) => r.remediation_id === 'test-noop')).toBe(false)
  })

  it('isolates a throwing remediation from the others', async () => {
    const good = vi.fn().mockResolvedValue({ acted: true, summary: 'ok' })
    registerRemediation(fakeRemediation('test-throws', async () => { throw new Error('boom') }))
    registerRemediation(fakeRemediation('test-ok', good))

    const result = await runAllRemediations()

    expect(result.failed.map((f) => f.id)).toContain('test-throws')
    expect(result.acted).toContain('test-ok')
    expect(good).toHaveBeenCalledOnce()

    // Thrown remediation logs a row with errors populated
    const rows = recentRemediations(60_000, true)
    const throwsRow = rows.find((r) => r.remediation_id === 'test-throws')
    expect(throwsRow).toBeDefined()
    expect(throwsRow?.errors).toContain('boom')
  })

  it('passes dryRun through to each remediation', async () => {
    const spy = vi.fn().mockResolvedValue({ acted: false, summary: 'skipped' })
    registerRemediation(fakeRemediation('test-dry', spy))

    await runAllRemediations({ dryRun: true })

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }))
  })

  it('registry has the four built-in remediations', () => {
    const ids = listRemediations().map((r) => r.id)
    expect(ids).toEqual(expect.arrayContaining([
      'paw-retry',
      'hallucinating-paw',
      'cost-cap-pauser',
      'stale-approval-skip',
    ]))
  })
})
