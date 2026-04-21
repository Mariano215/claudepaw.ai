// src/paws/collectors/github-community.ts
//
// Collector for cp-community-triage and any paw that watches a public GitHub
// repo for issues / PRs / basic stats.
//
// Runs three gh CLI calls and returns structured JSON. Never throws -- any
// failure goes into the errors array so the analyze phase still runs.
//
// Args:
//   { repo: "Owner/RepoName" }   -- required
//
// Defaults to YourGitHubUser/claudepaw.ai if no args and no GITHUB_COMMUNITY_REPO
// env var is set (legacy behavior for the original cp-community-triage paw).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Collector } from './index.js'

const execFileP = promisify(execFile)

interface GhIssue {
  number: number
  title: string
  labels: Array<{ name: string }> | string[]
  createdAt: string
  updatedAt: string
}

interface GhPR {
  number: number
  title: string
  author: { login?: string } | string
  createdAt: string
}

export interface GithubCommunityRaw {
  repo: string
  accessible: boolean
  stats?: { stars: number; forks: number; open_issues: number }
  issues?: Array<{
    number: number
    title: string
    labels: string[]
    createdAt: string
    updatedAt: string
    ageDays: number
  }>
  pulls?: Array<{
    number: number
    title: string
    author: string
    createdAt: string
    ageDays: number
  }>
  summary: {
    issue_count: number
    pr_count: number
    stars: number
    forks: number
  }
}

function resolveRepo(args?: Record<string, unknown>): string {
  const argRepo = typeof args?.repo === 'string' ? args.repo : ''
  if (argRepo) return argRepo
  return process.env.GITHUB_COMMUNITY_REPO ?? 'YourGitHubUser/claudepaw.ai'
}

function daysBetween(iso: string, now = Date.now()): number {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return 0
  return Math.round((now - t) / (1000 * 60 * 60 * 24))
}

async function runGh(args: string[]): Promise<{ stdout: string; error?: string }> {
  try {
    const { stdout } = await execFileP('gh', args, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    })
    return { stdout }
  } catch (err: any) {
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : ''
    const msg = stderr || (err instanceof Error ? err.message : String(err))
    return { stdout: '', error: msg }
  }
}

export const githubCommunityCollector: Collector = async (ctx) => {
  const repo = resolveRepo(ctx.args)
  const errors: string[] = []
  const result: GithubCommunityRaw = {
    repo,
    accessible: false,
    summary: { issue_count: 0, pr_count: 0, stars: 0, forks: 0 },
  }

  // 1. Probe existence + stats
  const stats = await runGh([
    'api',
    `repos/${repo}`,
    '--jq',
    '{stars: .stargazers_count, forks: .forks_count, open_issues: .open_issues_count}',
  ])
  if (stats.error) {
    errors.push(`stats: ${stats.error}`)
    // If stats fails we probably can't resolve the repo -- return what we have
    return {
      raw_data: result,
      collected_at: Date.now(),
      collector: 'github-community',
      errors,
    }
  }
  try {
    const parsed = JSON.parse(stats.stdout.trim() || '{}')
    result.stats = {
      stars: Number(parsed.stars ?? 0),
      forks: Number(parsed.forks ?? 0),
      open_issues: Number(parsed.open_issues ?? 0),
    }
    result.summary.stars = result.stats.stars
    result.summary.forks = result.stats.forks
    result.accessible = true
  } catch (err) {
    errors.push(`stats parse: ${(err as Error).message}`)
  }

  // 2. Issues
  const issues = await runGh([
    'issue',
    'list',
    '-R',
    repo,
    '--state',
    'open',
    '--json',
    'number,title,labels,createdAt,updatedAt',
  ])
  if (issues.error) {
    errors.push(`issues: ${issues.error}`)
  } else {
    try {
      const parsed: GhIssue[] = JSON.parse(issues.stdout.trim() || '[]')
      const now = Date.now()
      result.issues = parsed.map((i) => ({
        number: i.number,
        title: i.title,
        labels: Array.isArray(i.labels)
          ? i.labels.map((l) => (typeof l === 'string' ? l : l?.name ?? '')).filter(Boolean)
          : [],
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        ageDays: daysBetween(i.createdAt, now),
      }))
      result.summary.issue_count = result.issues.length
    } catch (err) {
      errors.push(`issues parse: ${(err as Error).message}`)
    }
  }

  // 3. PRs
  const prs = await runGh([
    'pr',
    'list',
    '-R',
    repo,
    '--state',
    'open',
    '--json',
    'number,title,author,createdAt',
  ])
  if (prs.error) {
    errors.push(`prs: ${prs.error}`)
  } else {
    try {
      const parsed: GhPR[] = JSON.parse(prs.stdout.trim() || '[]')
      const now = Date.now()
      result.pulls = parsed.map((p) => ({
        number: p.number,
        title: p.title,
        author:
          typeof p.author === 'string'
            ? p.author
            : p.author?.login ?? 'unknown',
        createdAt: p.createdAt,
        ageDays: daysBetween(p.createdAt, now),
      }))
      result.summary.pr_count = result.pulls.length
    } catch (err) {
      errors.push(`prs parse: ${(err as Error).message}`)
    }
  }

  return {
    raw_data: result,
    collected_at: Date.now(),
    collector: 'github-community',
    errors: errors.length ? errors : undefined,
  }
}
