import { describe, it, expect, vi, beforeEach } from 'vitest'

const credState = vi.hoisted(() => ({ token: 'ghp_test' as string | null }))
const knobState = vi.hoisted(() => ({ botLogin: 'paw-dev-bot' }))

vi.mock('../../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../credentials.js', () => ({ getCredential: () => credState.token }))
vi.mock('../../db.js', () => ({
  getKnob: (_projectId: string, key: string, fallback: string) =>
    key === 'repos' ? 'YourGitHubUser/ClaudePaw,YourGitHubUser/paw-trader'
      : key === 'bot_login' ? knobState.botLogin
      : fallback,
  getDb: () => ({ prepare: () => ({ get: () => undefined }) }),
}))
vi.mock('../../config.js', () => ({ PROJECT_ROOT: '/tmp' }))

import { createGithubDevCollector, parseRepoList, isSelfAuthored, type GhRunner, type GithubDevRaw } from './github-dev.js'

const ISSUES = JSON.stringify([
  { number: 42, title: 'Crash on empty list', labels: [{ name: 'bug' }], author: { login: 'headlinearena' },
    createdAt: '2026-09-08T10:00:00Z', updatedAt: '2026-09-08T10:00:00Z',
    comments: [{ author: { login: 'headlinearena' }, body: 'still broken', createdAt: '2026-09-09T09:00:00Z' }] },
  { number: 7, title: 'Self note', labels: [], author: { login: 'YourGitHubUser' },
    createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z', comments: [] },
])
const PRS = JSON.stringify([
  { number: 5, title: 'Add strategy docs', author: { login: 'headlinearena' }, headRefName: 'docs',
    createdAt: '2026-09-09T12:00:00Z', updatedAt: '2026-09-09T12:00:00Z', isCrossRepository: true },
])
const RUNS = JSON.stringify([{ conclusion: 'failure', status: 'completed', workflowName: 'ci', createdAt: '2026-09-10T01:00:00Z' }])

/** committer.date of the mirror's latest commit, controllable per test */
let mirrorCommitDate = '2026-09-09T00:00:00Z'

function runnerFor(calls: string[][]): GhRunner {
  return async (args, env) => {
    calls.push(args)
    expect(env.GH_TOKEN).toBe('ghp_test')
    if (args[0] === 'issue') return { stdout: ISSUES }
    if (args[0] === 'pr') return { stdout: PRS }
    if (args[0] === 'run') return { stdout: RUNS }
    if (args.join(' ').includes('dependabot/alerts')) return { stdout: '3' }
    if (args.join(' ').includes('commits')) return { stdout: mirrorCommitDate }
    return { stdout: '' }
  }
}

const ctx = { pawId: 'paw-dev-cycle', projectId: 'pawdev' }

describe('parseRepoList', () => {
  it('splits, trims and drops anything that is not Owner/Repo', () => {
    expect(parseRepoList(' a/b , c/d ,,garbage, e/f ')).toEqual(['a/b', 'c/d', 'e/f'])
  })
})

describe('isSelfAuthored', () => {
  it('tags the owner and the bot, nobody else', () => {
    expect(isSelfAuthored('YourGitHubUser', 'paw-dev-bot')).toBe(true)
    expect(isSelfAuthored('paw-dev-bot', 'paw-dev-bot')).toBe(true)
    expect(isSelfAuthored('headlinearena', 'paw-dev-bot')).toBe(false)
  })
})

describe('githubDevCollector', () => {
  let calls: string[][]
  beforeEach(() => {
    calls = []
    mirrorCommitDate = '2026-09-09T00:00:00Z'
  })

  it('makes one gh call per list per repo, never one per item', async () => {
    const collector = createGithubDevCollector(runnerFor(calls), { previousRaw: () => null, monorepoHeadCommittedAt: () => 0 })
    await collector(ctx)
    // YourGitHubUser/ClaudePaw is not a mirror: issue, pr, run, dependabot = 4 calls.
    // YourGitHubUser/paw-trader is a mirror: the same 4 plus the mirror-commit check = 5.
    // 4 + 5 = 9 total (ruling B8).
    expect(calls.length).toBe(9)
    expect(calls.filter(c => c[0] === 'issue')).toHaveLength(2)
  })

  it('tags owner-authored items as self and external ones as not', async () => {
    const collector = createGithubDevCollector(runnerFor(calls), { previousRaw: () => null, monorepoHeadCommittedAt: () => 0 })
    const out = await collector(ctx)
    const raw = out.raw_data as GithubDevRaw
    const repo = raw.repos[0]
    expect(repo.new_issues.find(i => i.number === 42)!.self).toBe(false)
    expect(repo.new_issues.find(i => i.number === 7)!.self).toBe(true)
  })

  it('reports the latest CI conclusion and the Dependabot count', async () => {
    const collector = createGithubDevCollector(runnerFor(calls), { previousRaw: () => null, monorepoHeadCommittedAt: () => 0 })
    const raw = (await collector(ctx)).raw_data as GithubDevRaw
    expect(raw.repos[0].ci.conclusion).toBe('failure')
    expect(raw.repos[0].dependabot_open).toBe(3)
  })

  it('filters by the watermark so a second cycle sees nothing new', async () => {
    const first = createGithubDevCollector(runnerFor(calls), { previousRaw: () => null, monorepoHeadCommittedAt: () => 0 })
    const firstRaw = (await first(ctx)).raw_data as GithubDevRaw

    const second = createGithubDevCollector(runnerFor(calls), { previousRaw: () => firstRaw, monorepoHeadCommittedAt: () => 0 })
    const secondRaw = (await second(ctx)).raw_data as GithubDevRaw

    expect(secondRaw.repos[0].new_issues).toHaveLength(0)
    expect(secondRaw.repos[0].new_comments).toHaveLength(0)
    // Unchanged input must produce an identical payload so skip_if_unchanged fires,
    // even when the monorepo HEAD (the builder's own commits) has moved on.
    expect(JSON.stringify(secondRaw)).toBe(JSON.stringify(
      ((await createGithubDevCollector(runnerFor(calls), { previousRaw: () => firstRaw, monorepoHeadCommittedAt: () => 999_999_999 })(ctx)).raw_data as GithubDevRaw),
    ))
  })

  it('reports not drifted when the mirror commit is newer than the monorepo HEAD', async () => {
    mirrorCommitDate = '2026-09-10T00:00:00Z'
    const monorepoAt = new Date('2026-09-09T00:00:00Z').getTime()
    const collector = createGithubDevCollector(runnerFor(calls), { previousRaw: () => null, monorepoHeadCommittedAt: () => monorepoAt })
    const raw = (await collector(ctx)).raw_data as GithubDevRaw
    const trader = raw.repos.find(r => r.repo === 'YourGitHubUser/paw-trader')!
    expect(trader.mirror_drift.drifted).toBe(false)
    expect(trader.mirror_drift.mirror_last_commit_at).toBe(new Date(mirrorCommitDate).getTime())
  })

  it('tags items filed by the bot login the knob names as self', async () => {
    knobState.botLogin = 'headlinearena'
    const collector = createGithubDevCollector(runnerFor(calls), { previousRaw: () => null, monorepoHeadCommittedAt: () => 1 })
    const raw = (await collector(ctx)).raw_data as GithubDevRaw
    const repo = raw.repos.find(r => r.repo === 'YourGitHubUser/ClaudePaw')!
    expect(repo.new_issues.find(i => i.number === 42)!.self).toBe(true)
    knobState.botLogin = 'paw-dev-bot'
  })

  it('marks which repos are mirrors, so the dashboard does not have to guess', async () => {
    const collector = createGithubDevCollector(runnerFor(calls), { previousRaw: () => null, monorepoHeadCommittedAt: () => 1 })
    const raw = (await collector(ctx)).raw_data as GithubDevRaw
    expect(raw.repos.find(r => r.repo === 'YourGitHubUser/paw-trader')!.is_mirror).toBe(true)
    expect(raw.repos.find(r => r.repo === 'YourGitHubUser/ClaudePaw')!.is_mirror).toBe(false)
  })

  it('flags mirror drift when the mirror commit is older than the monorepo HEAD', async () => {
    mirrorCommitDate = '2026-09-01T00:00:00Z'
    const monorepoAt = new Date('2026-09-09T00:00:00Z').getTime()
    const collector = createGithubDevCollector(runnerFor(calls), { previousRaw: () => null, monorepoHeadCommittedAt: () => monorepoAt })
    const raw = (await collector(ctx)).raw_data as GithubDevRaw
    const trader = raw.repos.find(r => r.repo === 'YourGitHubUser/paw-trader')!
    expect(trader.mirror_drift.drifted).toBe(true)
  })

  it('never throws: a failing gh call becomes an error string', async () => {
    const failing: GhRunner = async () => ({ stdout: '', error: 'gh: not found' })
    const collector = createGithubDevCollector(failing, { previousRaw: () => null, monorepoHeadCommittedAt: () => 0 })
    const out = await collector(ctx)
    expect(out.errors!.length).toBeGreaterThan(0)
    expect((out.raw_data as GithubDevRaw).repos[0].accessible).toBe(false)
  })

  it('never calls gh when the credential is missing, and reports the error', async () => {
    credState.token = null
    try {
      const collector = createGithubDevCollector(runnerFor(calls), { previousRaw: () => null, monorepoHeadCommittedAt: () => 0 })
      const out = await collector(ctx)
      expect(calls.length).toBe(0)
      expect(out.errors).toContain('missing credential pawdev/github/token')
      expect((out.raw_data as GithubDevRaw).repos[0].accessible).toBe(false)
    } finally {
      credState.token = 'ghp_test'
    }
  })

  it('reports the Dependabot count as null, not zero, on a non-404 error', async () => {
    const runner: GhRunner = async (args, env) => {
      if (args.join(' ').includes('dependabot/alerts')) return { stdout: '', error: 'HTTP 403: Resource not accessible' }
      return runnerFor(calls)(args, env)
    }
    const collector = createGithubDevCollector(runner, { previousRaw: () => null, monorepoHeadCommittedAt: () => 0 })
    const raw = (await collector(ctx)).raw_data as GithubDevRaw
    expect(raw.repos[0].dependabot_open).toBeNull()
    expect(raw.repos[0].errors.some(e => e.includes('dependabot'))).toBe(true)
  })
})
