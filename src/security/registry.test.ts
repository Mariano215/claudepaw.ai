import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub all scanner modules so loadScanners runs without real imports
vi.mock('./scanners/npm-audit.js',        () => ({ default: { id: 'npm-audit',        name: 'NPM',  description: '', scope: 'weekly', run: vi.fn() } }))
vi.mock('./scanners/tailscale-health.js', () => ({ default: { id: 'tailscale-health', name: 'Tail', description: '', scope: 'daily',  run: vi.fn() } }))
vi.mock('./scanners/ssl-check.js',        () => ({ default: { id: 'ssl-check',        name: 'SSL',  description: '', scope: 'daily',  run: vi.fn() } }))
vi.mock('./scanners/secret-scan.js',      () => ({ default: { id: 'secret-scan',      name: 'Sec',  description: '', scope: 'weekly', run: vi.fn() } }))
vi.mock('./scanners/port-scan.js',        () => ({ default: { id: 'port-scan',        name: 'Port', description: '', scope: 'daily',  run: vi.fn() } }))
vi.mock('./scanners/github-audit.js',     () => ({ default: { id: 'github-audit',     name: 'GH',   description: '', scope: 'weekly', run: vi.fn() } }))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { loadScanners, getScanner, getAllScanners, runSuite, runScanner } from './registry.js'
import type { ScanContext } from './types.js'

const ctx: ScanContext = {
  projectPaths: [], tailscaleNodes: [], domains: [], githubOwner: '', expectedPorts: {},
}

describe('security registry', () => {
  beforeEach(() => {
    loadScanners()
  })

  it('loadScanners registers all six', () => {
    expect(getAllScanners()).toHaveLength(6)
  })

  it('getScanner returns by id, undefined when missing', () => {
    expect(getScanner('npm-audit')?.id).toBe('npm-audit')
    expect(getScanner('does-not-exist')).toBeUndefined()
  })

  it('runSuite daily filters to daily-scoped scanners only', async () => {
    for (const s of getAllScanners()) {
      ;(s.run as any).mockResolvedValue({ findings: [], summary: '', durationMs: 1 })
    }
    const result = await runSuite('daily', ctx)
    // 3 daily scanners: tailscale-health, ssl-check, port-scan
    expect(result.scanResults.size).toBe(3)
  })

  it('runSuite weekly includes all scanners', async () => {
    for (const s of getAllScanners()) {
      ;(s.run as any).mockResolvedValue({ findings: [], summary: '', durationMs: 1 })
    }
    const result = await runSuite('weekly', ctx)
    expect(result.scanResults.size).toBe(6)
  })

  it('runSuite captures rejected scanners in errors map', async () => {
    const npm = getScanner('npm-audit')!
    ;(npm.run as any).mockRejectedValue(new Error('npm blew up'))
    for (const s of getAllScanners()) {
      if (s.id !== 'npm-audit') {
        ;(s.run as any).mockResolvedValue({ findings: [], summary: '', durationMs: 1 })
      }
    }
    const result = await runSuite('weekly', ctx)
    expect(result.errors.get('npm-audit')?.message).toBe('npm blew up')
    expect(result.scanResults.size).toBe(5)
  })

  it('runSuite aggregates findings across scanners', async () => {
    const npm = getScanner('npm-audit')!
    const ssl = getScanner('ssl-check')!
    ;(npm.run as any).mockResolvedValue({ findings: [{ id: 'f1' }, { id: 'f2' }], summary: '', durationMs: 1 })
    ;(ssl.run as any).mockResolvedValue({ findings: [{ id: 'f3' }], summary: '', durationMs: 1 })
    for (const s of getAllScanners()) {
      if (s.id !== 'npm-audit' && s.id !== 'ssl-check') {
        ;(s.run as any).mockResolvedValue({ findings: [], summary: '', durationMs: 1 })
      }
    }
    const result = await runSuite('weekly', ctx)
    expect(result.findings).toHaveLength(3)
  })

  it('runScanner throws on unknown id', async () => {
    await expect(runScanner('nope', ctx)).rejects.toThrow(/Unknown scanner/)
  })

  it('runScanner delegates to registered scanner', async () => {
    const npm = getScanner('npm-audit')!
    ;(npm.run as any).mockResolvedValue({ findings: [{ id: 'x' } as any], summary: 'ok', durationMs: 42 })
    const result = await runScanner('npm-audit', ctx)
    expect(result.findings).toHaveLength(1)
    expect(result.durationMs).toBe(42)
  })
})
