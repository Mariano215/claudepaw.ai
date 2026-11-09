// src/remediations/__tests__/hallucinating-paw.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `claudepaw-halluc-test-${process.pid}`)
const ENV_PATH = join(TEST_DIR, '.env')

vi.mock('../../config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const dir = path.join(os.tmpdir(), `claudepaw-halluc-test-${process.pid}`)
  return { STORE_DIR: dir, PROJECT_ROOT: dir, DASHBOARD_URL: '', DASHBOARD_API_TOKEN: '', BOT_API_TOKEN: '' }
})

vi.mock('../../env.js', async () => {
  const actual = (await vi.importActual('../../env.js')) as any
  const path = require('node:path')
  const os = require('node:os')
  const dir = path.join(os.tmpdir(), `claudepaw-halluc-test-${process.pid}`)
  return {
    ...actual,
    PROJECT_ROOT: dir,
    readEnvFile: () => {
      try {
        return actual.readEnvFile()
      } catch {
        return {}
      }
    },
  }
})

vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { initDatabase, getDb } from '../../db.js'
import { initRemediationsSchema } from '../db.js'
import { hallucinatingPawRemediation } from '../hallucinating-paw.js'

function seedHallucinatingCycles(
  pawId: string,
  projectId: string,
  count: number,
  provider: string,
): void {
  const db = getDb()

  // Test DB may have FK constraints from production initDatabase; disable for
  // isolated table seeding so we can create project_settings rows without
  // needing a matching `projects` row.
  db.pragma('foreign_keys = OFF')

  // Ensure required schema exists.
  db.exec(`
    CREATE TABLE IF NOT EXISTS paws (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      cron TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      config TEXT NOT NULL DEFAULT '{}',
      next_run INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paw_cycles (
      id TEXT PRIMARY KEY,
      paw_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      phase TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT '{}',
      findings TEXT NOT NULL DEFAULT '[]',
      actions_taken TEXT NOT NULL DEFAULT '[]',
      report TEXT,
      completed_at INTEGER,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS project_settings (
      project_id TEXT PRIMARY KEY,
      execution_provider TEXT,
      execution_provider_secondary TEXT
    );
  `)

  const now = Date.now()
  db.prepare('INSERT OR REPLACE INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
    pawId, projectId, pawId, 'test', '* * * * *', 'active', '{}', now, now,
  )
  db.prepare('INSERT OR REPLACE INTO project_settings (project_id, execution_provider, execution_provider_secondary) VALUES (?, ?, ?)').run(
    projectId, provider, null,
  )

  const hallucinatedState = JSON.stringify({
    observe_raw: 'some text with <tool_call>fake</tool_call> markers',
    analysis: null,
    decisions: null,
    approval_requested: false,
    approval_granted: null,
    act_result: null,
  })

  for (let i = 0; i < count; i++) {
    db.prepare('INSERT INTO paw_cycles (id, paw_id, started_at, phase, state) VALUES (?,?,?,?,?)').run(
      `cycle-${pawId}-${i}`, pawId, now - (i * 60_000), 'completed', hallucinatedState,
    )
  }
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  // Default: empty env, no skip list
  writeFileSync(ENV_PATH, '')
  initDatabase()
  initRemediationsSchema()
})

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('hallucinating-paw remediation', () => {
  it('switches provider when 3+ cycles show tool-call markers on non-claude_desktop', async () => {
    seedHallucinatingCycles('p1', 'proj-a', 3, 'anthropic_api')

    const outcome = await hallucinatingPawRemediation.run({ now: Date.now(), dryRun: false })

    expect(outcome.acted).toBe(true)
    expect(outcome.summary).toContain('proj-a')
    const detail = outcome.detail as { switched: Array<{ project_id: string; to: string }> }
    expect(detail.switched[0]).toMatchObject({ project_id: 'proj-a', to: 'claude_desktop' })

    const row = getDb().prepare(
      'SELECT execution_provider FROM project_settings WHERE project_id = ?',
    ).get('proj-a') as { execution_provider: string }
    expect(row.execution_provider).toBe('claude_desktop')
  })

  it('respects dryRun and does not mutate', async () => {
    seedHallucinatingCycles('p2', 'proj-b', 3, 'anthropic_api')

    await hallucinatingPawRemediation.run({ now: Date.now(), dryRun: true })

    const row = getDb().prepare(
      'SELECT execution_provider FROM project_settings WHERE project_id = ?',
    ).get('proj-b') as { execution_provider: string }
    expect(row.execution_provider).toBe('anthropic_api')
  })

  it('honors REMEDIATIONS_SKIP_PROJECTS opt-out', async () => {
    seedHallucinatingCycles('p3', 'proj-c', 3, 'anthropic_api')
    process.env.REMEDIATIONS_SKIP_PROJECTS = 'proj-c,other-proj'

    try {
      const outcome = await hallucinatingPawRemediation.run({ now: Date.now(), dryRun: false })

      expect(outcome.acted).toBe(false)
      const detail = outcome.detail as { detected: Array<{ project_id: string; reason: string }> }
      expect(detail.detected[0].reason).toContain('opted out')

      const row = getDb().prepare(
        'SELECT execution_provider FROM project_settings WHERE project_id = ?',
      ).get('proj-c') as { execution_provider: string }
      expect(row.execution_provider).toBe('anthropic_api') // untouched
    } finally {
      delete process.env.REMEDIATIONS_SKIP_PROJECTS
    }
  })

  it('no-op when fewer than 3 hallucinated cycles', async () => {
    seedHallucinatingCycles('p4', 'proj-d', 2, 'anthropic_api')

    const outcome = await hallucinatingPawRemediation.run({ now: Date.now(), dryRun: false })

    expect(outcome.acted).toBe(false)
  })

  it('skips projects already on claude_desktop', async () => {
    seedHallucinatingCycles('p5', 'proj-e', 5, 'claude_desktop')

    const outcome = await hallucinatingPawRemediation.run({ now: Date.now(), dryRun: false })

    expect(outcome.acted).toBe(false)
    const detail = outcome.detail as { detected: Array<{ project_id: string; reason: string }> }
    expect(detail.detected[0].reason).toContain('already on claude_desktop')
  })
})
