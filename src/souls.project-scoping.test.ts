// Regression test for the defect where routine (Paw) runs resolved no agent
// persona.  src/scheduler.ts, src/paws/index.ts and src/dashboard.ts all called
// getSoul(agentId) without the project slug, so an agent defined only under
// projects/<slug>/agents/ resolved to undefined.  The `if (soul)` branch was
// skipped, buildAgentPrompt never ran, and ACTION_PLAN_INSTRUCTIONS never
// reached the model -- which is what feeds parseActionItemsFromAgentOutput.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = mkdtempSync(join(tmpdir(), 'claudepaw-souls-scope-'))

vi.mock('./config.js', () => ({
  PROJECT_ROOT: ROOT,
  CLAUDE_CWD: ROOT,
  CREDENTIAL_ENCRYPTION_KEY: 'x'.repeat(32),
}))

const PROJECT_AGENT = `---
id: analyst
name: Signal Analyst
emoji: "\u{1F4C8}"
role: Trading Signal Analyst
mode: on-demand
---

Review the signal pipeline and report what changed.
`

const BROKER_AGENT = `---
id: scout
name: Lead Scout
emoji: "\u{1F3E0}"
role: Property Lead Sourcing
mode: on-demand
tools:
  - Read
  - Grep
  - Glob
  - Bash
  - TodoWrite
  - WebSearch
  - WebFetch
---

Source leads in the target zip tiers.
`

beforeAll(() => {
  // A project-scoped agent, and deliberately NO global agents/ entry for it.
  mkdirSync(join(ROOT, 'agents'), { recursive: true })
  mkdirSync(join(ROOT, 'projects', 'trader', 'agents'), { recursive: true })
  writeFileSync(join(ROOT, 'projects', 'trader', 'agents', 'analyst.md'), PROJECT_AGENT)
  // Non-default projects address agents by a composite id while the file
  // declares the bare template id. This is the broker shape.
  mkdirSync(join(ROOT, 'projects', 'broker', 'agents'), { recursive: true })
  writeFileSync(join(ROOT, 'projects', 'broker', 'agents', 'scout.md'), BROKER_AGENT)
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('getSoul project scoping', () => {
  it('does not resolve a project-only agent without the project slug', async () => {
    const { getSoul } = await import('./souls.js')
    expect(getSoul('analyst')).toBeUndefined()
  })

  it('resolves a project-only agent when the project is passed', async () => {
    const { getSoul } = await import('./souls.js')
    const soul = getSoul('analyst', 'trader')
    expect(soul).toBeDefined()
    expect(soul?.name).toBe('Signal Analyst')
  })

  // Every broker routine stores agent_id 'broker--scout' while the file declares
  // 'id: scout', so before this the lookup found nothing and the routine ran
  // with no persona even once the project slug was passed.
  it('resolves a composite <slug>--<template> agent id', async () => {
    const { getSoul } = await import('./souls.js')
    const soul = getSoul('broker--scout', 'broker')
    expect(soul).toBeDefined()
    expect(soul?.name).toBe('Lead Scout')
  })

  it('still resolves the bare id for the same agent', async () => {
    const { getSoul } = await import('./souls.js')
    expect(getSoul('scout', 'broker')?.name).toBe('Lead Scout')
  })

  // Round 5: WebSearch and WebFetch are denied unless a soul names them, so
  // the broker souls that document a web-search fallback now carry a tools:
  // list. If this frontmatter stops parsing, those fallbacks fail closed.
  it('parses a tools: list off the frontmatter', async () => {
    const { getSoul } = await import('./souls.js')
    expect(getSoul('scout', 'broker')?.tools).toEqual([
      'Read', 'Grep', 'Glob', 'Bash', 'TodoWrite', 'WebSearch', 'WebFetch',
    ])
  })

  it('does not strip a prefix belonging to a different project', async () => {
    const { getSoul } = await import('./souls.js')
    expect(getSoul('trader--scout', 'broker')).toBeUndefined()
  })

  it('builds a prompt carrying the action-plan instructions', async () => {
    const { getSoul, buildAgentPrompt } = await import('./souls.js')
    const soul = getSoul('analyst', 'trader')
    expect(soul).toBeDefined()
    const prompt = buildAgentPrompt(soul!, 'trader')
    // This block is the only thing parseActionItemsFromAgentOutput can act on.
    expect(prompt).toContain('## Action Items')
    expect(prompt).toContain('Signal Analyst')
    // Spec 4.2: plain gh and git push are denied, so the prompt must name the
    // wrappers or the agent has no GitHub path at all.
    expect(prompt).toContain('gh-wrapper.sh')
    expect(prompt).toContain('git-push-wrapper.sh')
    // The wrapper reads the subcommand from the first two non-flag tokens, so
    // a flag placed in front of it is refused. The prompt has to say so, and
    // has to name the allowlist, or an agent cannot tell why it was refused.
    expect(prompt).toContain('subcommand first')
    expect(prompt).toContain('Allowed subcommands: issue comment, issue close')
  })
})
