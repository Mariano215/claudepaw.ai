import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'seeds', 'projects.json'), 'utf-8'),
) as { projects: Array<{ id: string; kind?: string; settings?: Record<string, unknown> }> }

describe('canonical projects manifest', () => {
  it('carries pawdev as a Paw with an accent colour', () => {
    const row = manifest.projects.find(p => p.id === 'pawdev')
    expect(row).toBeDefined()
    expect(row!.kind).toBe('paw')
    expect(row!.settings!.primary_color).toBe('#38bdf8')
  })

  it('every entry declares a kind so the shell never guesses from the slug', () => {
    for (const p of manifest.projects) {
      expect(['project', 'paw']).toContain(p.kind)
    }
  })
})
