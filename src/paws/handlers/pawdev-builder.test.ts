import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

const rows: Array<Record<string, unknown>> = []
const transitions: Array<{ id: string; to: string }> = []
const fields: Array<{ id: string; f: Record<string, unknown> }> = []
const events: Array<Record<string, unknown>> = []
let credentialToken: string | null = 'ghp_test_token'

vi.mock('../../db.js', () => ({
  listActionItems: vi.fn((o: { status?: string }) => rows.filter(r => !o.status || r.status === o.status)),
  updateActionItemFields: vi.fn((id: string, f: Record<string, unknown>) => { fields.push({ id, f }) }),
  getDb: vi.fn(() => ({})),
}))
vi.mock('../../action-items.js', () => ({
  transitionActionItem: vi.fn((id: string, to: string) => {
    transitions.push({ id, to })
    const r = rows.find(x => x.id === id); if (r) r.status = to
  }),
}))
vi.mock('../../repo-events.js', () => ({
  writeRepoEvent: vi.fn((e: Record<string, unknown>) => { events.push(e); return 'ev1' }),
  listRepoEvents: vi.fn(() => []),
  repoEventStats: vi.fn(() => []),
}))
vi.mock('../../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../credentials.js', () => ({ getCredential: vi.fn(() => credentialToken) }))
vi.mock('../db.js', () => ({ getPaw: vi.fn(() => ({ id: 'paw-dev-cycle', project_id: 'pawdev', config: { chat_id: 'chat1' } })) }))
vi.mock('../pawdev/cards.js', () => ({ observeRawForCycle: vi.fn(() => null) }))
vi.mock('../pawdev/report.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), writeHistoryFile: vi.fn(() => '/tmp/HISTORY.md') }))

import { PROJECT_ROOT } from '../../config.js'
import { observeRawForCycle } from '../pawdev/cards.js'
import type { GithubDevRaw } from '../collectors/github-dev.js'
import {
  createPawdevBuilder, cardEffort, pickBuildableCard, branchNameFor, validateChangedFiles,
  type ShellRunner, type BuilderCard,
} from './pawdev-builder.js'

const PUSH_WRAPPER = join(PROJECT_ROOT, 'scripts', 'git-push-wrapper.sh')
const GH_WRAPPER = join(PROJECT_ROOT, 'scripts', 'gh-wrapper.sh')

function card(over: Partial<BuilderCard> & { status?: string } = {}): Record<string, unknown> {
  return {
    id: 'c1', project_id: 'pawdev', status: 'approved',
    title: 'Owner/repo-a#42 Crash on empty list',
    description: 'repro: run x\n\nrepo Owner/repo-a\nref #42\nkind bug\neffort small\nfiled by headlinearena',
    external_ref: JSON.stringify({ issue: 'github:Owner/repo-a#42' }),
    ...over,
  }
}

interface Call { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> }

/** Records every call as a `Call` (cmd, args, cwd, env). Every call succeeds
 * except `git status --porcelain`, which must stay empty (a non-empty answer
 * blocks the card before it starts) and whatever `override` intercepts. */
function trackedShell(seen: Call[], override?: (c: Call) => { code: number; stdout: string; stderr: string } | undefined): ShellRunner {
  return async (cmd, args, cwd, env) => {
    const call: Call = { cmd, args, cwd, env }
    seen.push(call)
    const result = override?.(call)
    if (result) return result
    if (cmd === 'git' && args[0] === 'status') return { code: 0, stdout: '', stderr: '' }
    if (cmd === GH_WRAPPER && args.includes('create')) return { code: 0, stdout: 'https://github.com/Owner/repo-a/pull/9', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

const goodPlan = async () => JSON.stringify({ changed_files: ['src/x.ts'], summary: 'fix crash', body: 'why' })

beforeEach(() => {
  rows.length = 0; transitions.length = 0; fields.length = 0; events.length = 0
  credentialToken = 'ghp_test_token'
})

describe('cardEffort', () => {
  it('reads the effort line the triage handler wrote', () => {
    expect(cardEffort('a\neffort trivial\nb')).toBe('trivial')
    expect(cardEffort('a\neffort large\nb')).toBe('large')
    expect(cardEffort('no effort line here')).toBe('unknown')
    expect(cardEffort(null)).toBe('unknown')
  })
})

describe('pickBuildableCard', () => {
  it('takes the smallest card', () => {
    const a = { id: 'a', title: 't', description: 'effort medium', external_ref: null, status: 'approved' }
    const b = { id: 'b', title: 't', description: 'effort small', external_ref: null, status: 'approved' }
    const c = { id: 'c', title: 't', description: 'effort trivial', external_ref: null, status: 'approved' }
    expect(pickBuildableCard([a, b, c])!.id).toBe('c')
  })

  it('returns null when everything queued is medium, large or unsized', () => {
    expect(pickBuildableCard([{ id: 'a', title: 't', description: 'effort large', external_ref: null, status: 'approved' }])).toBeNull()
    expect(pickBuildableCard([])).toBeNull()
  })
})

describe('branchNameFor', () => {
  it('slugs the title and ends with the issue number', () => {
    expect(branchNameFor(card() as unknown as BuilderCard)).toBe('fix/crash-on-empty-list-42')
  })

  it('falls back to the card id when the title slugs to nothing', () => {
    const noAscii = card({ id: 'c', title: 'ééé#42 ééé' }) as unknown as BuilderCard
    expect(branchNameFor(noAscii)).toBe('fix/c-42')
  })
})

describe('validateChangedFiles (Important 1 plus the automated HIGH finding)', () => {
  it('blocks path traversal, forbidden directories, forbidden files and flag-shaped entries', () => {
    expect(validateChangedFiles(['../../.env'])).toMatch(/traversal/)
    expect(validateChangedFiles(['store/claudepaw.db'])).toMatch(/forbidden path/)
    expect(validateChangedFiles(['package.json'])).toMatch(/forbidden file/)
    expect(validateChangedFiles(['-r'])).toMatch(/flag/)
    expect(validateChangedFiles(['vitest.config.ts'])).toMatch(/forbidden file/)
  })

  it('passes an ordinary worktree-relative source file', () => {
    expect(validateChangedFiles(['src/x.ts'])).toBeNull()
  })
})

describe('pawdev builder handler', () => {
  it('opens one pull request and leaves the card on Needs you, because merge is ask', async () => {
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({ sh: trackedShell(seen), runBuilderAgent: goodPlan })
    const raw: GithubDevRaw = {
      collected_for: ['Owner/repo-a'],
      watermark: {},
      repos: [{
        repo: 'Owner/repo-a', accessible: true,
        new_issues: [{ number: 42, title: 'Crash', labels: [], author: 'headlinearena', self: false, createdAt: '', updatedAt: '' }],
        new_prs: [], new_comments: [],
        ci: { conclusion: null, workflow: null, created_at: null },
        dependabot_open: 0, is_mirror: false, mirror_drift: { drifted: false, mirror_last_commit_at: null }, errors: [],
      }],
    }
    vi.mocked(observeRawForCycle).mockReturnValueOnce(raw)

    const result = await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(result).toBe('Owner/repo-a: 1 new, 0 coded, 0 waiting on you, 0 shipped')
    expect(transitions).toEqual([{ id: 'c1', to: 'in_progress' }, { id: 'c1', to: 'blocked' }])
    const joined = seen.map(s => [s.cmd, ...s.args].join(' '))
    expect(joined.some(s => s.includes(`worktree add ${join(PROJECT_ROOT, '.worktrees', 'pawdev-c1')} -b fix/crash-on-empty-list-42`))).toBe(true)
    expect(joined.some(s => s.includes('npm run typecheck'))).toBe(true)
    expect(joined.some(s => s.includes('vitest related --run'))).toBe(true)
    // Fix round 2 HIGH: vitest's own parser reads everything after `--` as
    // options['--'], never as `related`'s file-list positionals, so a
    // separator there silently runs zero tests. The file must be a plain
    // positional right after --run, with no -- token anywhere in the call.
    const vitestCall = seen.find(c => c.cmd === 'npx' && c.args[0] === 'vitest')!
    expect(vitestCall.args).toEqual(['vitest', 'related', '--run', 'src/x.ts'])
    expect(vitestCall.args).not.toContain('--')
    expect(joined.some(s => s.includes('leak-scan.sh'))).toBe(true)
    expect(joined.some(s => s.includes(`${GH_WRAPPER} pawdev pr create`))).toBe(true)
    expect(joined.some(s => s.includes('pr merge'))).toBe(false)
    expect(events).toEqual([expect.objectContaining({ kind: 'pr_opened', repo: 'Owner/repo-a', item_id: 'c1' })])
    expect(JSON.parse(String(fields.at(-1)!.f.external_ref))).toMatchObject({
      issue: 'github:Owner/repo-a#42', branch: 'fix/crash-on-empty-list-42', pr: 'https://github.com/Owner/repo-a/pull/9',
    })
  })

  it('links node_modules into the worktree after the add, and unlinks it before git add', async () => {
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({ sh: trackedShell(seen), runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    const worktreeDir = join(PROJECT_ROOT, '.worktrees', 'pawdev-c1')
    const names = seen.map(s => [s.cmd, ...s.args].join(' '))
    const addIdx = names.findIndex(s => s.startsWith('git worktree add'))
    const lnIdx = names.findIndex(s => s.startsWith('ln '))
    const rmIdx = names.findIndex(s => s.startsWith('rm '))
    const gitAddIdx = names.findIndex(s => s === 'git add -- src/x.ts')
    expect(lnIdx).toBe(addIdx + 1)
    expect(rmIdx).toBeLessThan(gitAddIdx)
    expect(seen[lnIdx]).toMatchObject({ cmd: 'ln', args: ['-s', join(PROJECT_ROOT, 'node_modules'), 'node_modules'], cwd: worktreeDir })
    // A symlink, so plain rm removes the link and never the real tree.
    expect(seen[rmIdx]).toMatchObject({ cmd: 'rm', args: ['node_modules'], cwd: worktreeDir })
    expect(seen[rmIdx]!.args).not.toContain('-r')
  })

  it('still refuses a changed_files entry under node_modules', () => {
    expect(validateChangedFiles(['node_modules/x'])).toContain('forbidden path')
  })

  it('never runs add -A or a bare checkout -b, only the worktree, and removes it after', async () => {
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({ sh: trackedShell(seen), runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    const joined = seen.map(s => [s.cmd, ...s.args].join(' '))
    expect(joined.some(s => s === 'git add -A')).toBe(false)
    expect(joined.some(s => /^git checkout -b /.test(s))).toBe(false)
    expect(joined.some(s => s === 'git add -- src/x.ts')).toBe(true)
    expect(joined.some(s => s === `git worktree remove ${join(PROJECT_ROOT, '.worktrees', 'pawdev-c1')} --force`)).toBe(true)
  })

  it('runs every worktree-scoped step with the worktree as cwd, and the wrappers by absolute path with GH_TOKEN', async () => {
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({ sh: trackedShell(seen), runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    const worktreeDir = join(PROJECT_ROOT, '.worktrees', 'pawdev-c1')
    const byCmd = (cmd: string) => seen.filter(c => c.cmd === cmd)
    expect(byCmd('npm').every(c => c.cwd === worktreeDir)).toBe(true)
    expect(byCmd('npx').every(c => c.cwd === worktreeDir)).toBe(true)
    const add = seen.find(c => c.cmd === 'git' && c.args[0] === 'add')!
    expect(add.cwd).toBe(worktreeDir)
    const commit = seen.find(c => c.cmd === 'git' && c.args[0] === 'commit')!
    expect(commit.cwd).toBe(worktreeDir)
    const push = seen.find(c => c.cmd === PUSH_WRAPPER)!
    expect(push.cmd.startsWith('/')).toBe(true)
    expect(push.cwd).toBe(worktreeDir)
    expect(push.env).toMatchObject({ GH_TOKEN: 'ghp_test_token' })
    const pr = seen.find(c => c.cmd === GH_WRAPPER && c.args.includes('create'))!
    expect(pr.cmd.startsWith('/')).toBe(true)
    expect(pr.cwd).toBe(worktreeDir)
    expect(pr.env).toMatchObject({ GH_TOKEN: 'ghp_test_token' })
  })

  it('runs the live-checkout steps and the leak scan from the project root, by absolute path', async () => {
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({ sh: trackedShell(seen), runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(seen.find(c => c.cmd === 'git' && c.args[0] === 'status')!.cwd).toBe(PROJECT_ROOT)
    expect(seen.find(c => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add')!.cwd).toBe(PROJECT_ROOT)
    const leak = seen.find(c => c.cmd.endsWith('leak-scan.sh'))!
    expect(leak.cmd).toBe(join(PROJECT_ROOT, 'scripts', 'lib', 'leak-scan.sh'))
    expect(leak.cwd).toBe(PROJECT_ROOT)
  })

  it('keeps the pushed branch and says so when the pull request fails', async () => {
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({
      sh: trackedShell(seen, c => (c.cmd === GH_WRAPPER && c.args.includes('create')
        ? { code: 1, stdout: '', stderr: 'gh: rate limited' } : undefined)),
      runBuilderAgent: goodPlan,
    })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(String(fields.at(-1)!.f.last_run_result))
      .toBe('pushed branch fix/crash-on-empty-list-42; PR failed: gh: rate limited')
    expect(seen.some(c => c.cmd === 'git' && c.args[0] === 'branch' && c.args[1] === '-D')).toBe(false)
  })

  it('reuses the pushed branch on a retry instead of failing on -b', async () => {
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({
      sh: trackedShell(seen, c => (c.cmd === 'git' && c.args[0] === 'branch' && c.args[1] === '--list'
        ? { code: 0, stdout: '  fix/crash-on-empty-list-42\n', stderr: '' } : undefined)),
      runBuilderAgent: goodPlan,
    })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    const add = seen.find(c => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add')!
    expect(add.args).toEqual(['worktree', 'add', join(PROJECT_ROOT, '.worktrees', 'pawdev-c1'), 'fix/crash-on-empty-list-42'])
    expect(add.args).not.toContain('-b')
  })

  it('keeps a reused branch when the worktree add fails, since its commits are pushed', async () => {
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({
      sh: trackedShell(seen, c => {
        if (c.cmd === 'git' && c.args[0] === 'branch' && c.args[1] === '--list') {
          return { code: 0, stdout: '  fix/crash-on-empty-list-42\n', stderr: '' }
        }
        if (c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add') {
          return { code: 1, stdout: '', stderr: 'directory already exists' }
        }
        return undefined
      }),
      runBuilderAgent: goodPlan,
    })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(seen.some(c => c.cmd === 'git' && c.args[0] === 'branch' && c.args[1] === '-D')).toBe(false)
  })

  it('still deletes a branch this attempt created when the worktree add fails', async () => {
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({
      sh: trackedShell(seen, c => (c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add'
        ? { code: 1, stdout: '', stderr: 'nope' } : undefined)),
      runBuilderAgent: goodPlan,
    })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(seen.some(c => c.cmd === 'git' && c.args.join(' ') === 'branch -D fix/crash-on-empty-list-42')).toBe(true)
  })

  it('blocks the card when the node_modules link cannot be made', async () => {
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({
      sh: trackedShell(seen, c => (c.cmd === 'ln' ? { code: 1, stdout: '', stderr: 'File exists' } : undefined)),
      runBuilderAgent: goodPlan,
    })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(String(fields.at(-1)!.f.last_run_result)).toBe('node_modules link failed: File exists')
    expect(seen.some(c => c.cmd === 'npm')).toBe(false)
  })

  it('a missing GitHub credential blocks the card before anything runs', async () => {
    credentialToken = null
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({ sh: trackedShell(seen), runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(transitions).toEqual([{ id: 'c1', to: 'blocked' }])
    expect(String(fields.at(-1)!.f.last_run_result)).toContain('missing credential pawdev/github/token')
    expect(seen.some(c => c.cmd === 'git' && c.args[0] === 'worktree')).toBe(false)
  })

  it('a dirty live checkout blocks the card before anything else runs', async () => {
    rows.push(card())
    const seen: Call[] = []
    const sh = trackedShell(seen, (c) => (c.cmd === 'git' && c.args[0] === 'status' ? { code: 0, stdout: ' M src/y.ts\n', stderr: '' } : undefined))
    const handler = createPawdevBuilder({ sh, runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(transitions).toEqual([{ id: 'c1', to: 'blocked' }])
    expect(String(fields.at(-1)!.f.last_run_result)).toContain('worktree dirty')
    expect(seen.some(c => c.cmd === 'git' && c.args[0] === 'worktree')).toBe(false)
  })

  it('a failed worktree add still deletes the branch it may have created', async () => {
    rows.push(card())
    const seen: Call[] = []
    const sh = trackedShell(seen, (c) => (c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add'
      ? { code: 1, stdout: '', stderr: "fatal: 'fix/crash-on-empty-list-42' already checked out" }
      : undefined))
    const handler = createPawdevBuilder({ sh, runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(transitions.at(-1)).toEqual({ id: 'c1', to: 'blocked' })
    expect(String(fields.at(-1)!.f.last_run_result)).toContain('worktree failed')
    expect(seen.some(c => c.cmd === 'git' && c.args[0] === 'branch' && c.args[1] === '-D' && c.args[2] === 'fix/crash-on-empty-list-42')).toBe(true)
  })

  it('a failing typecheck blocks the card and opens no pull request', async () => {
    rows.push(card())
    const seen: Call[] = []
    const sh = trackedShell(seen, (c) => (c.cmd === 'npm' ? { code: 2, stdout: '', stderr: 'TS2345: bad' } : undefined))
    const handler = createPawdevBuilder({ sh, runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(transitions.at(-1)).toEqual({ id: 'c1', to: 'blocked' })
    expect(seen.some(c => c.args.includes('create'))).toBe(false)
    expect(String(fields.at(-1)!.f.last_run_result)).toContain('TS2345')
  })

  it('a hostile changed_files entry blocks the card before typecheck runs', async () => {
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({
      sh: trackedShell(seen),
      runBuilderAgent: async () => JSON.stringify({ changed_files: ['../../.env'], summary: 's', body: 'b' }),
    })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(transitions.at(-1)).toEqual({ id: 'c1', to: 'blocked' })
    expect(String(fields.at(-1)!.f.last_run_result)).toContain('../../.env')
    expect(seen.some(c => c.cmd === 'npm')).toBe(false)
  })

  it('a non-zero git add blocks the card and opens no pull request', async () => {
    rows.push(card())
    const seen: Call[] = []
    const sh = trackedShell(seen, (c) => (c.cmd === 'git' && c.args[0] === 'add' ? { code: 1, stdout: '', stderr: 'fatal: pathspec' } : undefined))
    const handler = createPawdevBuilder({ sh, runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(transitions.at(-1)).toEqual({ id: 'c1', to: 'blocked' })
    expect(String(fields.at(-1)!.f.last_run_result)).toContain('git add failed')
    expect(seen.some(c => c.cmd === PUSH_WRAPPER)).toBe(false)
  })

  it('a non-zero git commit blocks the card and opens no pull request', async () => {
    rows.push(card())
    const seen: Call[] = []
    const sh = trackedShell(seen, (c) => (c.cmd === 'git' && c.args[0] === 'commit' ? { code: 1, stdout: '', stderr: 'nothing to commit' } : undefined))
    const handler = createPawdevBuilder({ sh, runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(transitions.at(-1)).toEqual({ id: 'c1', to: 'blocked' })
    expect(String(fields.at(-1)!.f.last_run_result)).toContain('git commit failed')
    expect(seen.some(c => c.cmd === PUSH_WRAPPER)).toBe(false)
  })

  it('a push the policy parks (exit 2) blocks the card and opens no pull request', async () => {
    rows.push(card())
    const seen: Call[] = []
    const sh = trackedShell(seen, (c) => (c.cmd === PUSH_WRAPPER ? { code: 2, stdout: '', stderr: 'push blocked by action policy (code.pr), decision code 2' } : undefined))
    const handler = createPawdevBuilder({ sh, runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(transitions.at(-1)).toEqual({ id: 'c1', to: 'blocked' })
    expect(String(fields.at(-1)!.f.last_run_result)).toContain('decision code 2')
    expect(seen.some(c => c.cmd === GH_WRAPPER)).toBe(false)
  })

  it('a leak in the diff blocks the card and opens no pull request', async () => {
    rows.push(card())
    const seen: Call[] = []
    const sh = trackedShell(seen, (c) => (c.cmd.includes('leak-scan.sh') ? { code: 1, stdout: "  LEAK: pattern 'example'", stderr: '' } : undefined))
    const handler = createPawdevBuilder({ sh, runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(transitions.at(-1)).toEqual({ id: 'c1', to: 'blocked' })
    expect(String(fields.at(-1)!.f.last_run_result)).toContain('LEAK')
  })

  it('a refusal from the builder blocks the card and opens no pull request', async () => {
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({
      sh: trackedShell(seen),
      runBuilderAgent: async () => JSON.stringify({ changed_files: [], summary: 'refused', body: 'no repro' }),
    })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(transitions.at(-1)).toEqual({ id: 'c1', to: 'blocked' })
    expect(seen.some(c => c.args.includes('create'))).toBe(false)
    expect(seen.some(c => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true)
  })

  it('every blocked path deletes the branch, since no push happened', async () => {
    rows.push(card())
    const seen: Call[] = []
    const sh = trackedShell(seen, (c) => (c.cmd === 'npm' ? { code: 2, stdout: '', stderr: 'bad' } : undefined))
    const handler = createPawdevBuilder({ sh, runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(seen.some(c => c.cmd === 'git' && c.args[0] === 'branch' && c.args[1] === '-D' && c.args[2] === 'fix/crash-on-empty-list-42')).toBe(true)
  })

  it('a successful pull request does not delete the branch', async () => {
    rows.push(card())
    const seen: Call[] = []
    const handler = createPawdevBuilder({ sh: trackedShell(seen), runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(seen.some(c => c.cmd === 'git' && c.args[0] === 'branch' && c.args[1] === '-D')).toBe(false)
  })

  it('a throw after the pull request opens still leaves the card readable, not stuck in_progress', async () => {
    rows.push(card())
    vi.mocked((await import('../../repo-events.js')).writeRepoEvent).mockImplementationOnce(() => { throw new Error('db gone') })
    const seen: Call[] = []
    const handler = createPawdevBuilder({ sh: trackedShell(seen), runBuilderAgent: goodPlan })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(transitions.at(-1)).toEqual({ id: 'c1', to: 'blocked' })
    expect(String(fields.at(-1)!.f.last_run_result)).toContain('db gone')
  })

  it('a medium card is left queued and nothing runs', async () => {
    rows.push(card({ description: 'effort medium' }))
    const seen: Call[] = []
    const handler = createPawdevBuilder({ sh: trackedShell(seen), runBuilderAgent: async () => '' })

    const result = await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(transitions).toEqual([])
    expect(seen).toEqual([])
    expect(rows[0].status).toBe('approved')
    expect(result).toBe('No collector payload this cycle.')
  })

  it('sends the merge approval card exactly once after a successful PR open', async () => {
    rows.push(card())
    const seen: Call[] = []
    const sendCalls: Array<{ chatId: string; text: string; keyboard: unknown; projectId?: string }> = []
    const send = async (chatId: string, text: string, keyboard: unknown, projectId?: string) => {
      sendCalls.push({ chatId, text, keyboard, projectId })
    }
    const handler = createPawdevBuilder({ sh: trackedShell(seen), runBuilderAgent: goodPlan, send })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0].chatId).toBe('chat1')
    expect(sendCalls[0].projectId).toBe('pawdev')
    expect(sendCalls[0].text).toContain('https://github.com/Owner/repo-a/pull/9')
    expect(sendCalls[0].text).toContain('Merge when ready')
    expect(sendCalls[0].keyboard).toEqual({
      inline_keyboard: [
        [
          { text: 'Post reply', callback_data: 'pawdev:reply:c1' },
          { text: 'Merge', callback_data: 'pawdev:merge:c1' },
        ],
        [
          { text: 'Regenerate mirror', callback_data: 'pawdev:mirror:c1' },
          { text: 'Close issue', callback_data: 'pawdev:close:c1' },
        ],
      ],
    })
    expect(transitions.at(-1)).toEqual({ id: 'c1', to: 'blocked' })
  })

  it('a send throw leaves the card blocked with the pull request url recorded', async () => {
    rows.push(card())
    const seen: Call[] = []
    const send = async () => { throw new Error('telegram down') }
    const handler = createPawdevBuilder({ sh: trackedShell(seen), runBuilderAgent: goodPlan, send })

    await handler('cy1', 'paw-dev-cycle', 'pawdev', '')

    expect(transitions.at(-1)).toEqual({ id: 'c1', to: 'blocked' })
    expect(String(fields.find(f => String(f.f.last_run_result).includes('pull request opened'))!.f.last_run_result))
      .toContain('https://github.com/Owner/repo-a/pull/9')
  })
})
