import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `claudepaw-paw-retry-test-${process.pid}`)

vi.mock('../../config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const dir = path.join(os.tmpdir(), `claudepaw-paw-retry-test-${process.pid}`)
  return { STORE_DIR: dir, PROJECT_ROOT: dir, DASHBOARD_URL: '', DASHBOARD_API_TOKEN: '', BOT_API_TOKEN: '' }
})

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { initDatabase, getDb } from '../../db.js'
import { initPawsTables, createPaw, createCycle, updateCycle, updatePawNextRun, getPaw } from '../../paws/db.js'
import { initRemediationsSchema } from '../db.js'
import { pawRetryRemediation } from '../paw-retry.js'
import type { PawConfig } from '../../paws/types.js'

const testConfig: PawConfig = {
  approval_threshold: 4,
  chat_id: '12345',
  approval_timeout_sec: 300,
}

function seedFailedCycle(error: string): string {
  const db = getDb()
  createPaw(db, {
    id: 'retry-paw',
    project_id: 'default',
    name: 'Retry Paw',
    agent_id: 'auditor',
    cron: '0 9 * * *',
    config: testConfig,
  })
  updatePawNextRun(db, 'retry-paw', Date.now() + 86_400_000)
  const cycleId = createCycle(db, 'retry-paw')
  updateCycle(db, cycleId, {
    phase: 'failed',
    completed_at: Date.now() - 11 * 60 * 1000,
    error,
  })
  return cycleId
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-22T09:00:00-04:00'))
  mkdirSync(TEST_DIR, { recursive: true })
  initDatabase()
  initPawsTables(getDb())
  initRemediationsSchema()
})

afterEach(() => {
  vi.useRealTimers()
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('paw-retry remediation', () => {
  it('retries transient failures by bumping next_run to now', async () => {
    seedFailedCycle('ECONNRESET while calling engine')

    const outcome = await pawRetryRemediation.run({ now: Date.now(), dryRun: false })

    expect(outcome.acted).toBe(true)
    expect(outcome.summary).toContain('retry-paw')
    expect(getPaw(getDb(), 'retry-paw')!.next_run).toBe(Date.now())
  })

  it('skips non-retryable failures like empty responses', async () => {
    seedFailedCycle('Agent returned no text for decide phase. Agent finished successfully but produced an empty result.')

    const outcome = await pawRetryRemediation.run({ now: Date.now(), dryRun: false })

    expect(outcome.acted).toBe(false)
    expect(outcome.summary).toContain('Skipped 1')
    expect(getPaw(getDb(), 'retry-paw')!.next_run).toBe(Date.now() + 86_400_000)
  })

  it('skips deterministic errors: API 4xx, unsupported CLI, bot crashed, fetch failed', async () => {
    seedFailedCycle('ANALYZE phase failed: Claude Code returned an error result: API Error: 400 Claude Code 2.1.141 does not support this model')

    const outcome = await pawRetryRemediation.run({ now: Date.now(), dryRun: false })

    expect(outcome.acted).toBe(false)
    expect(getPaw(getDb(), 'retry-paw')!.next_run).toBe(Date.now() + 86_400_000)
  })

  it('does not retry a failure that repeats the previous failed cycle error', async () => {
    const db = getDb()
    seedFailedCycle('ECONNRESET while calling engine')
    // Older cycle with the same error, completed 25 minutes ago
    const older = createCycle(db, 'retry-paw')
    db.prepare('UPDATE paw_cycles SET started_at = ? WHERE id = ?').run(Date.now() - 26 * 60 * 1000, older)
    updateCycle(db, older, { phase: 'failed', completed_at: Date.now() - 25 * 60 * 1000, error: 'ECONNRESET while calling engine' })

    const outcome = await pawRetryRemediation.run({ now: Date.now(), dryRun: false })

    expect(outcome.acted).toBe(false)
    expect(outcome.summary).toContain('Skipped 1')
    expect(getPaw(getDb(), 'retry-paw')!.next_run).toBe(Date.now() + 86_400_000)
  })
})
