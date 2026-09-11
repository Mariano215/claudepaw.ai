// The wrapper decides what an agent may run at all, before the policy layer
// sees anything. These cases run the real script. GH_WRAPPER_DRY_RUN stops the
// two allowed cases just before the policy call, so no test ever writes an
// approval card into store/claudepaw.db.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../src/config.js'

const WRAPPER = join(PROJECT_ROOT, 'scripts', 'gh-wrapper.sh')
// Every case runs with the seam on, so no probe can reach the policy layer
// and open a real approval card in store/claudepaw.db.
const DRY = { GH_WRAPPER_DRY_RUN: '1' }

function runWrapper(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(WRAPPER, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout: String(stdout), stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? -1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }
  }
}

describe('gh-wrapper.sh', () => {
  it('refuses pr merge and says where merging happens', () => {
    const out = runWrapper(['pawdev', 'pr', 'merge', '1', '-R', 'x/y'], DRY)
    expect(out.code).toBe(3)
    expect(out.stderr).toContain('gh pr merge is never automated; merge from the dashboard or the Telegram card')
  })

  it('refuses a merge whose flags are reordered, because the pair is off the allowlist', () => {
    // The subcommand is the first two non-flag tokens, so a flag value in
    // front of it shifts the pair and nothing on the allowlist matches.
    for (const probe of [
      ['pawdev', '-R', 'x/y', 'pr', 'merge', '1'],
      ['pawdev', 'pr', '-R', 'x/y', 'merge', '1'],
    ]) {
      const out = runWrapper(probe, DRY)
      expect(out.code, probe.join(' ')).toBe(3)
      expect(out.stderr).toContain('is not allowed through the wrapper')
    }
  })

  it('refuses gh api, including the REST route to a merge', () => {
    for (const probe of [['pawdev', 'api', 'repos/x/y'], ['pawdev', 'api', '-X', 'PUT', 'repos/x/y/pulls/1/merge']]) {
      const out = runWrapper(probe, DRY)
      expect(out.code, probe.join(' ')).toBe(3)
      expect(out.stderr).toContain('is not allowed through the wrapper')
    }
  })

  it('gives the allowlist message, not the merge refusal, for a stray token that merely contains the word merge', () => {
    // SUB is not exactly 'pr', so this must never be mistaken for pr merge.
    const out = runWrapper(['pawdev', 'repo-merge-tool', 'pr'], DRY)
    expect(out.code).toBe(3)
    expect(out.stderr).toContain('is not allowed through the wrapper')
    expect(out.stderr).not.toContain('gh pr merge is never automated')
  })

  it('refuses a quoted subcommand and anything else off the allowlist', () => {
    expect(runWrapper(['pawdev', 'pr merge', '1'], DRY).code).toBe(3)
    expect(runWrapper(['pawdev', 'repo', 'delete', 'x/y'], DRY).code).toBe(3)
  })

  it('names the allowlist when no subcommand is given', () => {
    const out = runWrapper(['pawdev'], DRY)
    expect(out.code).toBe(3)
    expect(out.stderr.trim()).toBe(
      'gh: no subcommand given; allowed: issue comment, issue close, issue view, issue list, pr create, pr comment, pr diff, pr view, pr list, run list, run view',
    )
  })

  it('lets the word merge through inside a title or body', () => {
    const out = runWrapper(
      ['pawdev', 'pr', 'create', '--title', 'merge helper', '--body', 'fixes the merge path'],
      DRY,
    )
    expect(out.code).toBe(0)
    expect(out.stdout.trim()).toBe('class=code.pr')
  })

  it('classes pr create as code.pr', () => {
    const out = runWrapper(['pawdev', 'pr', 'create', '--title', 'x', '--body', 'y'], DRY)
    expect(out.code).toBe(0)
    expect(out.stdout.trim()).toBe('class=code.pr')
  })

  it('classes issue comment as github.comment, flags in between and all', () => {
    const out = runWrapper(['pawdev', 'issue', 'comment', '1', '-R', 'x/y', '--body', 'z'], DRY)
    expect(out.code).toBe(0)
    expect(out.stdout.trim()).toBe('class=github.comment')
  })
})
