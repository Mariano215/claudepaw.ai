import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `claudepaw-action-items-integration-test-${process.pid}`)

vi.mock('./config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const dir = path.join(os.tmpdir(), `claudepaw-action-items-integration-test-${process.pid}`)
  return { STORE_DIR: dir, PROJECT_ROOT: dir }
})

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { createActionItem, transitionActionItem } from './action-items.js'
import {
  getActionItem,
  listActionItems,
  archiveStaleActionItems,
  listActionItemEvents,
  initDatabase,
  createProject,
} from './db.js'

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  initDatabase()
  // The action_items.project_id FK requires an existing project row.
  // createProject is idempotent against re-runs because we ignore the throw.
  try {
    createProject({
      id: 'integ-test',
      name: 'integ-test',
      slug: 'integ-test',
      display_name: 'Integration Test',
    })
  } catch {
    // already exists from a previous run
  }
})

afterAll(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('action items integration', () => {
  it('full lifecycle proposed -> approved -> in_progress -> completed', () => {
    const id = createActionItem({
      project_id: 'integ-test',
      title: 'Integration item',
      source: 'test',
      proposed_by: 'scout',
      executable_by_agent: true,
    })
    transitionActionItem(id, 'approved', 'human')
    transitionActionItem(id, 'in_progress', 'system')
    transitionActionItem(id, 'completed', 'system')
    const item = getActionItem(id)!
    expect(item.status).toBe('completed')
    expect(item.completed_at).toBeGreaterThan(0)
    const events = listActionItemEvents(id)
    expect(events.map(e => e.new_value)).toEqual([
      'proposed', 'approved', 'in_progress', 'completed',
    ])
  })

  it('auto-archive moves old completed items', () => {
    const id = createActionItem({
      project_id: 'integ-test',
      title: 'Old item',
      source: 'test',
      proposed_by: 'human',
    })
    transitionActionItem(id, 'approved', 'human')
    transitionActionItem(id, 'completed', 'human')
    // Cutoff in the future so our item looks old enough
    const cutoff = Date.now() + 1_000_000
    const archived = archiveStaleActionItems(cutoff)
    expect(archived).toBeGreaterThanOrEqual(1)
    expect(getActionItem(id)!.status).toBe('archived')
  })

  it('listActionItems excludes archived by default and includes them on request', () => {
    const items = listActionItems({ projectId: 'integ-test' })
    expect(items.every(i => i.status !== 'archived')).toBe(true)
    const all = listActionItems({ projectId: 'integ-test', includeArchived: true })
    expect(all.some(i => i.status === 'archived')).toBe(true)
  })
})
