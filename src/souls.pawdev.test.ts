import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('pawdev souls', () => {
  const dir = join(process.cwd(), 'projects', 'pawdev', 'agents')

  it('has exactly the four agents spec 6.2 names', () => {
    expect(readdirSync(dir).sort()).toEqual(['builder.md', 'maintainer.md', 'reviewer.md', 'triage.md'])
  })

  it('every soul is under 60 lines and declares its tools', () => {
    for (const f of readdirSync(dir)) {
      const body = readFileSync(join(dir, f), 'utf-8')
      expect(body.split('\n').length, f).toBeLessThan(60)
      expect(body, f).toMatch(/^tools:/m)
    }
  })

  it('only the builder may edit files', () => {
    const canEdit = readdirSync(dir).filter(f => /^\s+- Edit$/m.test(readFileSync(join(dir, f), 'utf-8')))
    expect(canEdit).toEqual(['builder.md'])
  })

  it('the builder does not declare Bash', () => {
    const body = readFileSync(join(dir, 'builder.md'), 'utf-8')
    expect(body).not.toMatch(/^\s+- Bash$/m)
  })

  it('no soul mentions a mirror checkout and none uses an em dash or en dash', () => {
    for (const f of readdirSync(dir)) {
      const body = readFileSync(join(dir, f), 'utf-8')
      expect(body, f).not.toMatch(/claudepaw-oss|paw-trader-mirror|paw-broker-mirror/)
      expect(body, f).not.toMatch(/[–—]/)
    }
  })

  it('the folded claudepaw souls are gone', () => {
    const cp = readdirSync(join(process.cwd(), 'projects', 'claudepaw', 'agents'))
    expect(cp).toContain('ecosystem-researcher.md')
    for (const gone of ['platform-developer.md', 'community-manager.md', 'repo-maintainer.md']) {
      expect(cp).not.toContain(gone)
    }
  })
})
