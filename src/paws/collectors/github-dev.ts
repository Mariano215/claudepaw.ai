// src/paws/collectors/github-dev.ts
//
// OBSERVE for the paw-dev-cycle routine. Extends github-community with the
// four things a maintainer actually needs: CI, Dependabot, new comments, and
// mirror drift, across every repo in the pawdev.repos knob.
//
// Rules this file enforces so the routine stays cheap and honest:
//   - one gh call per list per repo, never one call per issue
//   - a watermark, so a quiet cycle produces a byte-identical payload and
//     skip_if_unchanged ends the cycle without a single LLM call
//   - the bot token, read from the credential store, never from the ambient
//     gh login, so an action never lands under the owner's name by accident
//   - it never throws; every failure is a string in errors

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { getCredential } from '../../credentials.js'
import { getKnob, getDb } from '../../db.js'
import { PROJECT_ROOT } from '../../config.js'
import { logger } from '../../logger.js'
import type { Collector, CollectorContext, CollectorResult } from './index.js'

const execFileP = promisify(execFile)

export const DEFAULT_PAWDEV_REPOS = [
  'YourGitHubUser/ClaudePaw',
  'YourGitHubUser/claudepaw.ai',
  'YourGitHubUser/paw-trader',
  'YourGitHubUser/claude-paw-website',
  'YourGitHubUser/paw-broker',
]

/** Repos that are generated from the monorepo. Nothing is ever committed to one. */
const MIRROR_REPOS = new Set(['YourGitHubUser/claudepaw.ai', 'YourGitHubUser/paw-trader', 'YourGitHubUser/paw-broker'])

const DEFAULT_OWNER_LOGIN = 'YourGitHubUser'
const DEFAULT_BOT_LOGIN = 'paw-dev-bot'

export type GhRunner = (args: string[], env: Record<string, string>) => Promise<{ stdout: string; error?: string }>

export interface DevIssue {
  number: number
  title: string
  labels: string[]
  author: string
  self: boolean
  createdAt: string
  updatedAt: string
}

export interface DevPr extends DevIssue {
  headRefName: string
  from_fork: boolean
}

export interface DevComment {
  issue: number
  author: string
  self: boolean
  body: string
  createdAt: string
}

export interface GithubDevRepo {
  repo: string
  accessible: boolean
  new_issues: DevIssue[]
  new_prs: DevPr[]
  new_comments: DevComment[]
  ci: { conclusion: string | null; workflow: string | null; created_at: string | null }
  /** null means the count is unknown (an error, not a real zero), never a guess. */
  dependabot_open: number | null
  /** True for a repo generated from the monorepo. The Repos page reads this. */
  is_mirror: boolean
  mirror_drift: { drifted: boolean; mirror_last_commit_at: number | null }
  errors: string[]
}

export interface GithubDevRaw {
  collected_for: string[]
  /** Per repo high-water mark in milliseconds. Advances only when something new appears. */
  watermark: Record<string, number>
  repos: GithubDevRepo[]
}

export function parseRepoList(knobValue: string): string[] {
  return knobValue
    .split(',')
    .map(s => s.trim())
    .filter(s => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s))
}

export function isSelfAuthored(login: string, botLogin = DEFAULT_BOT_LOGIN, ownerLogin = DEFAULT_OWNER_LOGIN): boolean {
  return login === ownerLogin || login === botLogin
}

function ms(iso: string): number {
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : 0
}

function login(author: unknown): string {
  if (typeof author === 'string') return author
  const l = (author as { login?: string } | null)?.login
  return l ?? 'unknown'
}

async function realGh(args: string[], env: Record<string, string>): Promise<{ stdout: string; error?: string }> {
  try {
    const { stdout } = await execFileP('gh', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      env: { ...process.env, ...env },
    })
    return { stdout }
  } catch (err: unknown) {
    const stderr = typeof (err as { stderr?: string })?.stderr === 'string' ? (err as { stderr: string }).stderr.trim() : ''
    return { stdout: '', error: stderr || (err instanceof Error ? err.message : String(err)) }
  }
}

function parseJson<T>(text: string, fallback: T): T {
  try { return JSON.parse(text.trim() || 'null') ?? fallback } catch { return fallback }
}

/** A repo entry with nothing collected, used when there is no token to call gh with. */
function emptyRepo(repo: string): GithubDevRepo {
  return {
    repo,
    accessible: false,
    new_issues: [],
    new_prs: [],
    new_comments: [],
    ci: { conclusion: null, workflow: null, created_at: null },
    dependabot_open: null,
    is_mirror: MIRROR_REPOS.has(repo),
    mirror_drift: { drifted: false, mirror_last_commit_at: null },
    errors: [],
  }
}

export function createGithubDevCollector(
  run: GhRunner,
  deps: { previousRaw?: () => GithubDevRaw | null; monorepoHeadCommittedAt?: () => number | null } = {},
): Collector {
  return async (ctx: CollectorContext): Promise<CollectorResult> => {
    const token = getCredential('pawdev', 'github', 'token') ?? ''
    const knob = getKnob('pawdev', 'repos', DEFAULT_PAWDEV_REPOS.join(','))
    const repos = parseRepoList(String(knob))

    if (!token) {
      const raw: GithubDevRaw = {
        collected_for: repos,
        watermark: {},
        repos: repos.map(repo => emptyRepo(repo)),
      }
      return {
        raw_data: raw,
        collected_at: Date.now(),
        collector: 'github-dev',
        errors: ['missing credential pawdev/github/token'],
      }
    }

    const env: Record<string, string> = { GH_TOKEN: token }
    const ownerLogin = getKnob('pawdev', 'owner_login', DEFAULT_OWNER_LOGIN)
    // A knob, not a constant: if the real bot account has another name, nothing
    // it files would be tagged self (final review, Minor 13).
    const botLogin = getKnob('pawdev', 'bot_login', DEFAULT_BOT_LOGIN)
    const previous = deps.previousRaw?.() ?? null
    const monorepoAt = deps.monorepoHeadCommittedAt?.() ?? null
    const errors: string[] = []
    const watermark: Record<string, number> = {}
    const out: GithubDevRepo[] = []

    for (const repo of repos) {
      const since = previous?.watermark?.[repo] ?? 0
      const r: GithubDevRepo = { ...emptyRepo(repo), accessible: true, dependabot_open: 0 }
      let high = since

      // 1. Open issues with their comments. One call, comments included.
      const issues = await run(
        ['issue', 'list', '-R', repo, '--state', 'open', '--limit', '100',
         '--json', 'number,title,labels,author,createdAt,updatedAt,comments'], env)
      if (issues.error) {
        r.accessible = false
        r.errors.push(`issues: ${issues.error}`)
        errors.push(`${repo} issues: ${issues.error}`)
      } else {
        for (const i of parseJson<Array<Record<string, unknown>>>(issues.stdout, [])) {
          const created = ms(String(i.createdAt))
          const author = login(i.author)
          if (created > since) {
            r.new_issues.push({
              number: Number(i.number), title: String(i.title),
              labels: Array.isArray(i.labels) ? (i.labels as Array<{ name?: string }>).map(l => l?.name ?? '').filter(Boolean) : [],
              author, self: isSelfAuthored(author, botLogin, ownerLogin), createdAt: String(i.createdAt), updatedAt: String(i.updatedAt),
            })
            if (created > high) high = created
          }
          for (const c of (Array.isArray(i.comments) ? i.comments : []) as Array<Record<string, unknown>>) {
            const at = ms(String(c.createdAt))
            if (at <= since) continue
            const cAuthor = login(c.author)
            r.new_comments.push({
              issue: Number(i.number), author: cAuthor, self: isSelfAuthored(cAuthor, botLogin, ownerLogin),
              body: String(c.body ?? '').slice(0, 2000), createdAt: String(c.createdAt),
            })
            if (at > high) high = at
          }
        }
      }

      // 2. Open pull requests.
      const prs = await run(
        ['pr', 'list', '-R', repo, '--state', 'open', '--limit', '50',
         '--json', 'number,title,author,createdAt,updatedAt,headRefName,isCrossRepository'], env)
      if (prs.error) {
        r.errors.push(`prs: ${prs.error}`)
      } else {
        for (const p of parseJson<Array<Record<string, unknown>>>(prs.stdout, [])) {
          const created = ms(String(p.createdAt))
          if (created <= since) continue
          const author = login(p.author)
          r.new_prs.push({
            number: Number(p.number), title: String(p.title), labels: [],
            author, self: isSelfAuthored(author, botLogin, ownerLogin),
            createdAt: String(p.createdAt), updatedAt: String(p.updatedAt),
            headRefName: String(p.headRefName ?? ''), from_fork: p.isCrossRepository === true,
          })
          if (created > high) high = created
        }
      }

      // 3. Latest CI run on the default branch. One call, limit 1.
      const runs = await run(['run', 'list', '-R', repo, '--limit', '1', '--json', 'conclusion,status,workflowName,createdAt'], env)
      if (runs.error) {
        r.errors.push(`ci: ${runs.error}`)
      } else {
        const first = parseJson<Array<Record<string, unknown>>>(runs.stdout, [])[0]
        if (first) {
          r.ci = {
            conclusion: first.conclusion ? String(first.conclusion) : null,
            workflow: first.workflowName ? String(first.workflowName) : null,
            created_at: first.createdAt ? String(first.createdAt) : null,
          }
        }
      }

      // 4. Dependabot open alert count. 404 when the feature is off; that is a
      //    real zero. Any other error (403 lacking security_events, etc.)
      //    means the count is unknown, so it goes to null, never a guessed 0.
      const dep = await run(['api', `repos/${repo}/dependabot/alerts?state=open&per_page=100`, '--jq', 'length'], env)
      if (dep.error) {
        if (/404|not found|disabled/i.test(dep.error)) {
          r.dependabot_open = 0
        } else {
          r.dependabot_open = null
          r.errors.push(`dependabot: ${dep.error}`)
        }
      } else {
        const n = Number(dep.stdout.trim())
        r.dependabot_open = Number.isFinite(n) ? n : 0
      }

      // 5. Mirror drift. Every sync commit lands after the monorepo commit it
      //    mirrors, so a mirror whose latest commit is OLDER than the monorepo
      //    HEAD is behind. Compare committer timestamps, not commit text: none
      //    of the sync scripts stamp the monorepo SHA into the message.
      //    monorepoAt never enters raw_data (ruling C6): it changes on every
      //    commit the builder makes, which would break skip_if_unchanged.
      if (MIRROR_REPOS.has(repo)) {
        const c = await run(['api', `repos/${repo}/commits?per_page=1`, '--jq', '.[0].commit.committer.date'], env)
        if (c.error) {
          r.errors.push(`mirror: ${c.error}`)
        } else {
          const dateStr = c.stdout.split('\n')[0]?.trim() ?? ''
          const mirrorAt = dateStr ? ms(dateStr) : null
          r.mirror_drift.mirror_last_commit_at = mirrorAt
          r.mirror_drift.drifted = monorepoAt !== null && mirrorAt !== null && monorepoAt > mirrorAt
        }
      }

      watermark[repo] = high
      out.push(r)
    }

    const raw: GithubDevRaw = { collected_for: repos, watermark, repos: out }
    logger.info({ pawId: ctx.pawId, repos: repos.length, errors: errors.length }, '[paws] github-dev collected')
    return {
      raw_data: raw,
      collected_at: Date.now(),
      collector: 'github-dev',
      errors: errors.length ? errors : undefined,
    }
  }
}

/** Reads the previous cycle's collector payload out of paw_cycles.state.observe_raw. */
function previousRawFromDb(pawId: string): GithubDevRaw | null {
  try {
    const row = getDb().prepare(
      `SELECT state FROM paw_cycles WHERE paw_id = ? AND phase IN ('completed','report')
        ORDER BY started_at DESC LIMIT 1`,
    ).get(pawId) as { state: string } | undefined
    if (!row) return null
    const state = JSON.parse(row.state) as { observe_raw?: string | null }
    if (!state.observe_raw) return null
    const payload = JSON.parse(state.observe_raw) as { raw_data?: GithubDevRaw }
    return payload.raw_data ?? null
  } catch {
    return null
  }
}

/** Committer timestamp of the monorepo's own HEAD, in milliseconds. */
function monorepoHeadCommittedAtMs(): number | null {
  try {
    const seconds = execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim()
    const n = Number(seconds)
    return Number.isFinite(n) ? n * 1000 : null
  } catch {
    return null
  }
}

export const githubDevCollector: Collector = async (ctx) =>
  createGithubDevCollector(realGh, {
    previousRaw: () => previousRawFromDb(ctx.pawId),
    monorepoHeadCommittedAt: monorepoHeadCommittedAtMs,
  })(ctx)
