import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('../db.js', () => ({
  initDatabase: () => testDb,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  upsertFinding,
  getAllFindings,
  getOpenFindings,
  updateFindingStatus,
  markFindingsResolved,
  recordScan,
  getRecentScans,
  logAutoFix,
  getAutoFixLog,
  snapshotScore,
  getScoreHistory,
} from './persistence.js'
import type { Finding } from './types.js'

function mkFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: `f-${Math.random().toString(36).slice(2, 8)}`,
    scannerId: 'npm-audit',
    severity: 'high',
    title: 'CVE-1234',
    description: 'vuln',
    target: 'package.json',
    autoFixable: false,
    autoFixed: false,
    fixDescription: undefined,
    status: 'open',
    firstSeen: 1_000,
    lastSeen: 2_000,
    resolvedAt: undefined,
    metadata: {},
    ...overrides,
  }
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE security_findings (
    id TEXT PRIMARY KEY,
    scanner_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    target TEXT NOT NULL,
    auto_fixable INTEGER NOT NULL,
    auto_fixed INTEGER NOT NULL,
    fix_description TEXT,
    status TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    resolved_at INTEGER,
    metadata TEXT NOT NULL DEFAULT '{}',
    UNIQUE(scanner_id, title, target)
  )`,
  `CREATE TABLE security_scans (
    id TEXT PRIMARY KEY, scanner_id TEXT, started_at INTEGER,
    duration_ms INTEGER, findings_count INTEGER, trigger TEXT
  )`,
  `CREATE TABLE security_auto_fixes (
    id TEXT PRIMARY KEY, finding_id TEXT, scanner_id TEXT,
    action TEXT, success INTEGER, detail TEXT, created_at INTEGER
  )`,
  `CREATE TABLE security_score_history (
    date TEXT PRIMARY KEY, score INTEGER,
    critical_count INTEGER, high_count INTEGER,
    medium_count INTEGER, low_count INTEGER
  )`,
]

function createSchema(db: Database.Database) {
  for (const stmt of SCHEMA_STATEMENTS) {
    db.prepare(stmt).run()
  }
}

describe('security persistence', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    createSchema(testDb)
  })
  afterEach(() => { testDb.close() })

  it('upsertFinding inserts a new row', () => {
    upsertFinding(mkFinding())
    expect(getAllFindings()).toHaveLength(1)
  })

  it('upsertFinding on conflict updates last_seen but not first_seen', () => {
    const f = mkFinding({ firstSeen: 100, lastSeen: 200 })
    upsertFinding(f)
    upsertFinding({ ...f, firstSeen: 9999, lastSeen: 500, id: 'new-id' })
    const rows = getAllFindings()
    expect(rows).toHaveLength(1)
    expect(rows[0].lastSeen).toBe(500)
    expect(rows[0].firstSeen).toBe(100)
  })

  it('upsertFinding reopens a finding that was previously fixed', () => {
    const f = mkFinding()
    upsertFinding(f)
    updateFindingStatus(f.id, 'fixed')
    upsertFinding({ ...f, id: 'ignored-because-conflict' })
    const rows = getAllFindings()
    expect(rows[0].status).toBe('open')
  })

  it('getOpenFindings returns only status=open, sorted critical first', () => {
    upsertFinding(mkFinding({ id: 'a', title: 'low-one',  severity: 'low',      target: 't1' }))
    upsertFinding(mkFinding({ id: 'b', title: 'crit-one', severity: 'critical', target: 't2' }))
    upsertFinding(mkFinding({ id: 'c', title: 'high-one', severity: 'high',     target: 't3' }))
    updateFindingStatus('a', 'fixed')
    const open = getOpenFindings()
    expect(open.map(f => f.severity)).toEqual(['critical', 'high'])
  })

  it('getAllFindings filters by severity/scanner/status', () => {
    upsertFinding(mkFinding({ id: 'a', title: 't1', severity: 'high',   scannerId: 'npm-audit' }))
    upsertFinding(mkFinding({ id: 'b', title: 't2', severity: 'medium', scannerId: 'ssl-check' }))
    expect(getAllFindings({ severity: 'high' })).toHaveLength(1)
    expect(getAllFindings({ scannerId: 'ssl-check' })).toHaveLength(1)
    expect(getAllFindings({ status: 'open' })).toHaveLength(2)
    expect(getAllFindings({ status: 'fixed' })).toHaveLength(0)
  })

  it('markFindingsResolved closes findings not in current set', () => {
    upsertFinding(mkFinding({ id: 'a', title: 'CVE-A', scannerId: 'npm-audit', target: 'pkg' }))
    upsertFinding(mkFinding({ id: 'b', title: 'CVE-B', scannerId: 'npm-audit', target: 'pkg' }))
    const changed = markFindingsResolved('npm-audit', 'pkg', ['CVE-A'])
    expect(changed).toBe(1)
    expect(getOpenFindings().map(f => f.title)).toEqual(['CVE-A'])
  })

  it('markFindingsResolved with empty list closes all open findings for that scanner+target', () => {
    upsertFinding(mkFinding({ id: 'a', title: 'CVE-A', scannerId: 'npm-audit', target: 'pkg' }))
    upsertFinding(mkFinding({ id: 'b', title: 'CVE-B', scannerId: 'npm-audit', target: 'pkg' }))
    const changed = markFindingsResolved('npm-audit', 'pkg', [])
    expect(changed).toBe(2)
    expect(getOpenFindings()).toHaveLength(0)
  })

  it('recordScan + getRecentScans round-trip newest first', () => {
    recordScan({ id: 's1', scannerId: 'npm-audit', startedAt: 100, durationMs: 10, findingsCount: 0, trigger: 'manual' })
    recordScan({ id: 's2', scannerId: 'ssl-check', startedAt: 200, durationMs: 20, findingsCount: 3, trigger: 'scheduled' })
    const recent = getRecentScans(10)
    expect(recent.map(s => s.id)).toEqual(['s2', 's1'])
  })

  it('logAutoFix + getAutoFixLog records success/failure correctly', () => {
    logAutoFix('f1', 'npm-audit', 'upgrade', true, 'bumped to 2.0')
    logAutoFix('f2', 'npm-audit', 'upgrade', false, 'peer dep conflict')
    const log = getAutoFixLog(10)
    expect(log).toHaveLength(2)
    expect(log.find(e => e.findingId === 'f1')?.success).toBe(true)
    expect(log.find(e => e.findingId === 'f2')?.success).toBe(false)
  })

  it('snapshotScore writes today row with per-severity counts', () => {
    upsertFinding(mkFinding({ id: 'a', title: 't1', severity: 'critical' }))
    upsertFinding(mkFinding({ id: 'b', title: 't2', severity: 'high' }))
    upsertFinding(mkFinding({ id: 'c', title: 't3', severity: 'high' }))
    const snap = snapshotScore()
    expect(snap.criticalCount).toBe(1)
    expect(snap.highCount).toBe(2)
    // score = 100 - (1*25 + 2*10) = 55
    expect(snap.score).toBe(55)
    expect(snap.date).toBe(new Date().toISOString().slice(0, 10))
  })

  it('snapshotScore upserts on same-date (does not duplicate)', () => {
    upsertFinding(mkFinding({ severity: 'high' }))
    snapshotScore()
    snapshotScore()
    expect(getScoreHistory(30)).toHaveLength(1)
  })
})
