import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config.js', () => ({
  SECURITY_AUTO_FIX_MAX_SEVERITY: 'medium',
}))

const mockScanner = {
  id: 'npm-audit',
  autoFix: vi.fn(),
}

vi.mock('./registry.js', () => ({
  getScanner: (id: string) => (id === 'npm-audit' ? mockScanner : undefined),
}))

const logCalls: any[] = []
vi.mock('./persistence.js', () => ({
  logAutoFix: (...args: any[]) => { logCalls.push(args) },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { runAutoFixes } from './auto-fix.js'
import type { Finding } from './types.js'

function mkFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: `f-${Math.random().toString(36).slice(2, 8)}`,
    scannerId: 'npm-audit',
    severity: 'medium',
    title: 'vuln',
    description: 'd',
    target: 'pkg',
    autoFixable: true,
    autoFixed: false,
    status: 'open',
    firstSeen: 0,
    lastSeen: 0,
    metadata: {},
    ...overrides,
  }
}

describe('runAutoFixes', () => {
  beforeEach(() => {
    mockScanner.autoFix.mockReset()
    logCalls.length = 0
  })

  it('returns empty when no eligible findings', async () => {
    const result = await runAutoFixes([])
    expect(result).toEqual([])
  })

  it('skips findings with autoFixable=false', async () => {
    await runAutoFixes([mkFinding({ autoFixable: false })])
    expect(mockScanner.autoFix).not.toHaveBeenCalled()
  })

  it('skips findings above severity threshold', async () => {
    // threshold is medium (rank 2). critical (rank 4) must be skipped.
    await runAutoFixes([mkFinding({ severity: 'critical' })])
    expect(mockScanner.autoFix).not.toHaveBeenCalled()
  })

  it('skips findings exactly one rank above threshold (high, when threshold=medium)', async () => {
    // Boundary case: high = rank 3, medium threshold = rank 2. Off-by-one
    // (>= vs >) bugs in the comparator would pass this finding through.
    mockScanner.autoFix.mockResolvedValue([])
    await runAutoFixes([mkFinding({ severity: 'high' })])
    expect(mockScanner.autoFix).not.toHaveBeenCalled()
  })

  it('includes findings at or below the threshold', async () => {
    mockScanner.autoFix.mockResolvedValue([])
    await runAutoFixes([mkFinding({ severity: 'low' }), mkFinding({ severity: 'medium' })])
    expect(mockScanner.autoFix).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'low' }),
        expect.objectContaining({ severity: 'medium' }),
      ]),
    )
  })

  it('includes finding exactly AT threshold (medium when threshold=medium)', async () => {
    // Boundary: threshold is inclusive. This pins the "<=" half of the comparator.
    mockScanner.autoFix.mockResolvedValue([])
    await runAutoFixes([mkFinding({ severity: 'medium' })])
    expect(mockScanner.autoFix).toHaveBeenCalledTimes(1)
  })

  it('groups findings by scanner before calling autoFix', async () => {
    mockScanner.autoFix.mockResolvedValue([])
    const a = mkFinding({ id: 'a' })
    const b = mkFinding({ id: 'b' })
    await runAutoFixes([a, b])
    expect(mockScanner.autoFix).toHaveBeenCalledTimes(1)
    expect(mockScanner.autoFix.mock.calls[0][0]).toHaveLength(2)
  })

  it('skips scanner with no autoFix method', async () => {
    const result = await runAutoFixes([mkFinding({ scannerId: 'no-fix-scanner' })])
    expect(result).toEqual([])
  })

  it('logs each result (success and failure) via logAutoFix', async () => {
    mockScanner.autoFix.mockResolvedValue([
      { findingId: 'a', success: true,  description: 'bumped' },
      { findingId: 'b', success: false, description: 'blocked' },
    ])
    await runAutoFixes([mkFinding({ id: 'a' }), mkFinding({ id: 'b' })])
    expect(logCalls).toHaveLength(2)
    expect(logCalls[0][3]).toBe(true)
    expect(logCalls[1][3]).toBe(false)
    // Action (arg 3) is a stable verb; detail (arg 5) is the per-fix description.
    // Previously both were the description -- the audit log lost the distinction.
    expect(logCalls[0][2]).toBe('auto-fix')
    expect(logCalls[0][4]).toBe('bumped')
    expect(logCalls[1][2]).toBe('auto-fix')
    expect(logCalls[1][4]).toBe('blocked')
  })

  it('catches scanner.autoFix throws and records failure per finding', async () => {
    mockScanner.autoFix.mockRejectedValue(new Error('scanner crashed'))
    const results = await runAutoFixes([mkFinding({ id: 'a' }), mkFinding({ id: 'b' })])
    expect(results).toHaveLength(2)
    expect(results.every(r => !r.success)).toBe(true)
    expect(results[0].description).toMatch(/scanner crashed/)
    // Persistence must still be called even though the scanner threw.
    // Previously there was no assertion on this; a refactor that moves
    // logAutoFix outside the catch would pass the shape test but lose audit rows.
    expect(logCalls).toHaveLength(2)
    expect(logCalls.every(c => c[3] === false)).toBe(true)
  })
})
