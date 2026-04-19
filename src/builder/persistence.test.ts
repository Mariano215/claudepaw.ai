import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

// Create a fresh in-memory DB for each test suite run, avoiding production DB
let memDb: Database.Database

vi.mock('../db.js', () => ({
  initDatabase: vi.fn(() => memDb),
}))

import {
  createBuilderTables,
  logDecision,
  getDecisions,
  addTechDebt,
  getTechDebt,
  resolveTechDebt,
  updateTechDebtStatus,
} from './persistence.js'

beforeEach(() => {
  memDb = new Database(':memory:')
  memDb.pragma('journal_mode = WAL')
  createBuilderTables()
})

describe('architecture_decisions', () => {
  it('logs a decision and retrieves it', () => {
    const id = logDecision(
      'test-project',
      'Choosing a database',
      'Use SQLite',
      'Embedded, no extra process, good for single-user',
      ['PostgreSQL', 'MySQL'],
    )

    expect(id).toBeTruthy()
    expect(typeof id).toBe('string')

    const decisions = getDecisions('test-project')
    const found = decisions.find(d => d.id === id)
    expect(found).toBeDefined()
    expect(found!.project).toBe('test-project')
    expect(found!.decision).toBe('Use SQLite')
    expect(found!.rationale).toBe('Embedded, no extra process, good for single-user')
    expect(found!.alternatives).toEqual(['PostgreSQL', 'MySQL'])
    expect(found!.createdAt).toBeGreaterThan(0)
  })

  it('filters by project', () => {
    logDecision('project-a', 'ctx', 'dec-a', 'rat')
    logDecision('project-b', 'ctx', 'dec-b', 'rat')

    const aDecisions = getDecisions('project-a')
    const bDecisions = getDecisions('project-b')

    expect(aDecisions.every(d => d.project === 'project-a')).toBe(true)
    expect(bDecisions.every(d => d.project === 'project-b')).toBe(true)
  })

  it('returns all decisions when no project filter', () => {
    logDecision('p1', 'ctx', 'dec', 'rat')
    const all = getDecisions()
    expect(all.length).toBeGreaterThan(0)
  })

  it('respects limit', () => {
    logDecision('p1', 'ctx', 'dec1', 'rat')
    logDecision('p1', 'ctx', 'dec2', 'rat')
    const limited = getDecisions(undefined, 1)
    expect(limited.length).toBe(1)
  })
})

describe('tech_debt', () => {
  it('adds tech debt and retrieves it', () => {
    const id = addTechDebt(
      'test-project',
      'Missing error handling in API',
      'The /api/status endpoint has no try-catch',
      'medium',
      'src/api/status.ts',
    )

    expect(id).toBeTruthy()

    const items = getTechDebt('test-project')
    const found = items.find(d => d.id === id)
    expect(found).toBeDefined()
    expect(found!.title).toBe('Missing error handling in API')
    expect(found!.severity).toBe('medium')
    expect(found!.filePath).toBe('src/api/status.ts')
    expect(found!.status).toBe('open')
    expect(found!.resolvedAt).toBeNull()
  })

  it('filters by status', () => {
    const id = addTechDebt('test-project', 'Old debt', 'will resolve', 'low')
    resolveTechDebt(id)

    const open = getTechDebt('test-project', 'open')
    const resolved = getTechDebt('test-project', 'resolved')

    expect(open.every(d => d.status === 'open')).toBe(true)
    expect(resolved.some(d => d.id === id)).toBe(true)
    expect(resolved.find(d => d.id === id)!.resolvedAt).toBeGreaterThan(0)
  })

  it('updates status to in-progress', () => {
    const id = addTechDebt('test-project', 'WIP debt', 'working on it', 'high')
    updateTechDebtStatus(id, 'in-progress')

    const items = getTechDebt('test-project', 'in-progress')
    const found = items.find(d => d.id === id)
    expect(found).toBeDefined()
    expect(found!.status).toBe('in-progress')
  })

  it('sorts by severity', () => {
    addTechDebt('sort-test', 'Low item', '', 'low')
    addTechDebt('sort-test', 'Critical item', '', 'critical')
    addTechDebt('sort-test', 'High item', '', 'high')

    const items = getTechDebt('sort-test')
    const severities = items.map(d => d.severity)
    expect(severities.indexOf('critical')).toBeLessThan(severities.indexOf('high'))
    expect(severities.indexOf('high')).toBeLessThan(severities.indexOf('low'))
  })
})
