import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { buildProjectSnapshot, _clearSnapshotCache } from './project-snapshot.js'
import { createBudget } from './budget.js'
import { getDb, initDatabase } from '../db.js'

beforeAll(() => initDatabase())

describe('buildProjectSnapshot', () => {
  beforeEach(() => _clearSnapshotCache())

  it('empty for unknown project', async () => {
    expect(await buildProjectSnapshot('nonexistent', createBudget(2000))).toBe('')
  })

  it('includes project header for real project', async () => {
    const row = getDb().prepare('SELECT id FROM projects LIMIT 1').get() as { id: string } | undefined
    if (!row) return
    const r = await buildProjectSnapshot(row.id, createBudget(2000))
    expect(r).toContain('[Project:')
  })

  it('caches 30s', async () => {
    const row = getDb().prepare('SELECT id FROM projects LIMIT 1').get() as { id: string } | undefined
    if (!row) return
    expect(await buildProjectSnapshot(row.id, createBudget(2000)))
      .toBe(await buildProjectSnapshot(row.id, createBudget(2000)))
  })
})
