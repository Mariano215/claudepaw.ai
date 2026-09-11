import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// souls.ts reads PROJECT_ROOT from ./config.js at import time, so mock that
// module before souls.ts is imported (the vi.mock('./config.js') form).
const root = mkdtempSync(path.join(tmpdir(), 'souls-alias-'))

vi.mock('./config.js', () => ({ PROJECT_ROOT: root, CREDENTIAL_ENCRYPTION_KEY: 'test' }))

beforeAll(() => {
  mkdirSync(path.join(root, 'agents'), { recursive: true })
  mkdirSync(path.join(root, 'projects', 'demo', 'agents'), { recursive: true })
  writeFileSync(path.join(root, 'CLAUDE.md'), '# fixture\n')
  writeFileSync(
    path.join(root, 'agents', 'security-scanner.md'),
    ['---',
     'id: security-scanner',
     'name: Security Scanner',
     'emoji: S',
     'role: Dependency and infra scanner',
     'mode: active',
     'aliases:',
     '  - auditor',
     '---',
     'Scan things.'].join('\n'),
  )
  writeFileSync(
    path.join(root, 'projects', 'demo', 'agents', 'content-researcher.md'),
    ['---',
     'id: content-researcher',
     'name: Content Researcher',
     'emoji: C',
     'role: Video and content research',
     'mode: active',
     'aliases:',
     '  - scout',
     '---',
     'Research things.'].join('\n'),
  )
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('soul aliases', () => {
  it('parses the aliases list', async () => {
    const { loadAllSouls } = await import('./souls.js')
    const souls = loadAllSouls()
    expect(souls.get('security-scanner')?.aliases).toEqual(['auditor'])
  })

  it('resolves a base soul by its old id', async () => {
    const { loadAllSouls, getSoul } = await import('./souls.js')
    loadAllSouls()
    expect(getSoul('auditor')?.id).toBe('security-scanner')
  })

  it('resolves a project soul by its old id', async () => {
    const { loadAllSouls, getSoul } = await import('./souls.js')
    loadAllSouls('demo')
    expect(getSoul('scout', 'demo')?.id).toBe('content-researcher')
  })

  it('resolves a composite old id through the alias', async () => {
    const { loadAllSouls, getSoul } = await import('./souls.js')
    loadAllSouls('demo')
    expect(getSoul('demo--scout', 'demo')?.id).toBe('content-researcher')
  })

  it('leaves an unknown id unresolved', async () => {
    const { loadAllSouls, getSoul } = await import('./souls.js')
    loadAllSouls()
    expect(getSoul('nope')).toBeUndefined()
  })
})
