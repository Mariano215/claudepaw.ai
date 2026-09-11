// Guard for the silent-skip class of defect.
//
// src/souls.ts drops any agent file with missing or invalid frontmatter and only
// logs a warning, so one wrong word disables an agent and nothing fails. That is
// how projects/default/agents/api-monitor.md sat with `mode: scheduled` (not a
// valid mode) and the claude-platform-tracker routine ran with no persona,
// which also meant it never received the action-plan instructions.
//
// This test asserts every agent file either loads or is a documented exception.
import { describe, it, expect } from 'vitest'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadAllSouls } from './souls.js'
import { PROJECT_ROOT } from './config.js'

/**
 * Files under an agents/ directory that are deliberately NOT souls.
 *
 * The committee prompts are read directly by src/trader/committee.ts
 * (COMMITTEE_PROMPT_FILES), so they carry no frontmatter on purpose.
 *
 * orchestrator.md is different: it is a stale Phase 0 prompt, it cannot load as
 * a soul, and projects/trader/project.json still declares `trader--orchestrator`
 * pointing at it. Nothing in src/ reads project.json, so the declaration is
 * dead. Listed here to keep this test honest, not because it is correct.
 */
const NON_SOUL_FILES = new Set([
  'trader/committee-coordinator.md',
  'trader/committee-fundamentalist.md',
  'trader/committee-macro.md',
  'trader/committee-quant.md',
  'trader/committee-risk-officer.md',
  'trader/committee-sentiment.md',
  'trader/committee-trader.md',
  'trader/orchestrator.md',
])

function agentFiles(): Array<{ key: string; project: string | null; file: string }> {
  const out: Array<{ key: string; project: string | null; file: string }> = []
  const globalDir = join(PROJECT_ROOT, 'agents')
  if (existsSync(globalDir)) {
    for (const f of readdirSync(globalDir).filter((f) => f.endsWith('.md'))) {
      out.push({ key: f, project: null, file: f })
    }
  }
  const projectsDir = join(PROJECT_ROOT, 'projects')
  if (existsSync(projectsDir)) {
    for (const slug of readdirSync(projectsDir)) {
      const dir = join(projectsDir, slug, 'agents')
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
        out.push({ key: `${slug}/${f}`, project: slug, file: f })
      }
    }
  }
  return out
}

describe('agent files load', () => {
  const files = agentFiles()

  it('finds agent files to check', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('every agent file loads as a soul, or is a documented exception', () => {
    const loadedByProject = new Map<string | null, Set<string>>()
    loadedByProject.set(null, new Set(loadAllSouls().keys()))
    for (const slug of new Set(files.map((f) => f.project).filter((p): p is string => p !== null))) {
      loadedByProject.set(slug, new Set(loadAllSouls(slug).keys()))
    }

    const unloaded = files
      .filter((f) => !NON_SOUL_FILES.has(f.key))
      .filter((f) => !loadedByProject.get(f.project)?.has(f.file.replace(/\.md$/, '')))
      .map((f) => f.key)

    // A failure here means a frontmatter field is missing or invalid. Check the
    // loader warnings: souls.ts requires id, name, emoji, role and a mode of
    // always-on | active | on-demand.
    expect(unloaded).toEqual([])
  })
})
