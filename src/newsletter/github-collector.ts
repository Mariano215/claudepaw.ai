import { execFileSync } from 'node:child_process'
import { logger } from '../logger.js'
import { GITHUB_CONFIG, GITHUB_TOPIC_QUERIES } from './config.js'
import { filterUnseenRepos } from './github-dedup.js'
import type { RawRepo, RepoTag, ScoredRepo } from './types.js'

// ---------------------------------------------------------------------------
// Token resolution: explicit env var, falling back to gh CLI keychain.
// Returns empty string when neither path works (collector then logs a warn
// and bails — newsletter still ships with an empty GH section).
// ---------------------------------------------------------------------------

function resolveGithubToken(): string {
  const fromEnv = (process.env.GITHUB_TOKEN || '').trim()
  if (fromEnv) return fromEnv
  try {
    const out = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// GH Search API response shape (subset we need)
// ---------------------------------------------------------------------------

interface SearchRepoItem {
  full_name: string
  html_url: string
  description: string | null
  stargazers_count: number
  language: string | null
  pushed_at: string
  created_at: string
  topics?: string[]
}

interface SearchResponse {
  items?: SearchRepoItem[]
  message?: string
}

interface ReleaseResponse {
  tag_name?: string
  published_at?: string
  message?: string
}

// ---------------------------------------------------------------------------
// Low-level fetch helpers
// ---------------------------------------------------------------------------

async function ghFetch<T>(url: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ClaudePaw-Newsletter',
      },
    })
    if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = res.headers.get('x-ratelimit-reset')
      logger.warn({ url, reset }, 'GH rate limit reached — returning partial')
      return null
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      logger.warn({ url, status: res.status, body }, 'GH fetch non-OK')
      return null
    }
    return (await res.json()) as T
  } catch (err) {
    logger.warn({ url, err }, 'GH fetch failed')
    return null
  }
}

async function ghSearch(
  query: string,
  sort: 'stars' | 'updated',
  perPage: number,
  token: string,
): Promise<SearchRepoItem[]> {
  const url =
    `https://api.github.com/search/repositories` +
    `?q=${encodeURIComponent(query)}&sort=${sort}&order=desc&per_page=${perPage}`
  const data = await ghFetch<SearchResponse>(url, token)
  return data?.items ?? []
}

async function ghLatestRelease(
  fullName: string,
  token: string,
): Promise<{ tag: string; publishedAt: Date } | null> {
  const url = `https://api.github.com/repos/${fullName}/releases/latest`
  const data = await ghFetch<ReleaseResponse>(url, token)
  if (!data?.tag_name || !data.published_at) return null
  return { tag: data.tag_name, publishedAt: new Date(data.published_at) }
}

// ---------------------------------------------------------------------------
// Tag inference: prefer matchedQuery's tag, but boost cyber/agentic from topics
// when an "ai" generic match clearly belongs to a more specific tag.
// ---------------------------------------------------------------------------

const AGENTIC_HINTS = new Set([
  'agentic-ai', 'ai-agents', 'llm-agents', 'autonomous-agents', 'agent-framework',
  'agent', 'agents', 'agentic',
])
const CYBER_HINTS = new Set([
  'offensive-security', 'red-team', 'blue-team', 'llm-security', 'security-tools',
  'threat-intelligence', 'security', 'cybersecurity', 'pentest', 'pentesting',
])

export function inferTag(repo: RawRepo): RepoTag {
  const topics = new Set(repo.topics.map((t) => t.toLowerCase()))
  // Agentic wins if both agentic and ai topics are present
  if ([...topics].some((t) => AGENTIC_HINTS.has(t))) return 'agentic'
  if ([...topics].some((t) => CYBER_HINTS.has(t))) return 'cyber'
  return mapQueryToTag(repo.matchedQuery) ?? 'ai'
}

function mapQueryToTag(query: string): RepoTag | null {
  const found = GITHUB_TOPIC_QUERIES.find((g) => g.q === query)
  return found?.tag ?? null
}

// ---------------------------------------------------------------------------
// Deterministic scoring (used for shortlist ordering + LLM fallback ordering)
// ---------------------------------------------------------------------------

export function scoreRepo(repo: RawRepo): number {
  const daysSincePushed = Math.max(
    1,
    Math.floor((Date.now() - repo.pushedAt.getTime()) / 86_400_000),
  )
  const recencyDecay = 1 / Math.log2(daysSincePushed + 2)
  let score = repo.stars * recencyDecay

  // Bonus: fresh release in last 7 days
  if (
    repo.latestReleaseAt &&
    Date.now() - repo.latestReleaseAt.getTime() < 7 * 86_400_000
  ) {
    score += 200
  }

  // Bonus: high-signal topics
  const topics = new Set(repo.topics.map((t) => t.toLowerCase()))
  if (topics.has('agentic-ai') || topics.has('llm-security')) {
    score += 50
  }

  return Math.round(score)
}

// ---------------------------------------------------------------------------
// Public: collect raw candidates across all topic queries (both buckets)
// ---------------------------------------------------------------------------

function rawFromSearch(
  item: SearchRepoItem,
  bucket: 'rising' | 'established',
  matchedQuery: string,
  release: { tag: string; publishedAt: Date } | null,
): RawRepo {
  return {
    fullName: item.full_name,
    url: item.html_url,
    description: item.description ?? '',
    stars: item.stargazers_count,
    language: item.language,
    pushedAt: new Date(item.pushed_at),
    createdAt: new Date(item.created_at),
    topics: item.topics ?? [],
    latestReleaseTag: release?.tag ?? null,
    latestReleaseAt: release?.publishedAt ?? null,
    bucket,
    matchedQuery,
  }
}

export async function collectRepoCandidates(): Promise<RawRepo[]> {
  const token = resolveGithubToken()
  if (!token) {
    logger.warn('No GITHUB_TOKEN and no gh CLI auth — GH section will render empty')
    return []
  }

  const pushedAfter = isoDateDaysAgo(GITHUB_CONFIG.pushedWithinDays)
  const createdAfter = isoDateDaysAgo(GITHUB_CONFIG.risingMaxAgeDays)

  const seenFullNames = new Set<string>()
  const candidates: RawRepo[] = []

  // ---- Rising bucket ----
  for (const { q, tag: _tag } of GITHUB_TOPIC_QUERIES) {
    const query =
      `${q} stars:${GITHUB_CONFIG.risingMinStars}..${GITHUB_CONFIG.risingMaxStars}` +
      ` pushed:>=${pushedAfter} created:>=${createdAfter}`
    const items = await ghSearch(query, 'stars', GITHUB_CONFIG.perQueryLimit, token)
    for (const item of items) {
      if (seenFullNames.has(item.full_name)) continue
      seenFullNames.add(item.full_name)
      candidates.push(rawFromSearch(item, 'rising', q, null))
    }
    await sleep(GITHUB_CONFIG.apiThrottleMs)
  }

  // ---- Established bucket ----
  // Search then per-repo release check (filter by release within releaseWithinDays).
  const releaseCutoff = Date.now() - GITHUB_CONFIG.releaseWithinDays * 86_400_000
  for (const { q, tag: _tag } of GITHUB_TOPIC_QUERIES) {
    const query = `${q} stars:>${GITHUB_CONFIG.establishedMinStars} pushed:>=${pushedAfter}`
    const items = await ghSearch(query, 'updated', GITHUB_CONFIG.perQueryLimit, token)
    for (const item of items) {
      if (seenFullNames.has(item.full_name)) continue
      // Per-repo release lookup (rate-limit sensitive — throttle between each)
      const release = await ghLatestRelease(item.full_name, token)
      await sleep(GITHUB_CONFIG.apiThrottleMs)
      if (!release || release.publishedAt.getTime() < releaseCutoff) continue
      seenFullNames.add(item.full_name)
      candidates.push(rawFromSearch(item, 'established', q, release))
    }
    await sleep(GITHUB_CONFIG.apiThrottleMs)
  }

  logger.info(
    {
      total: candidates.length,
      rising: candidates.filter((c) => c.bucket === 'rising').length,
      established: candidates.filter((c) => c.bucket === 'established').length,
    },
    'GH candidates collected',
  )
  return candidates
}

// ---------------------------------------------------------------------------
// Public: shortlist — dedup + bucket mix + cap
// ---------------------------------------------------------------------------

export function shortlistRepos(
  candidates: RawRepo[],
  opts: { bypassDedup?: boolean } = {},
): ScoredRepo[] {
  // Dedup: drop repos shown in last 90d unless new release tag.
  // Bypass mode used by one-shot republish flows.
  const fresh = opts.bypassDedup
    ? candidates
    : filterUnseenRepos(candidates, GITHUB_CONFIG.dedupWindowDays)

  // Score everything
  const scored: ScoredRepo[] = fresh.map((c) => ({
    ...c,
    tag: inferTag(c),
    score: scoreRepo(c),
    whyItMatters: '',
  }))

  // Split + sort by score desc
  const rising = scored.filter((s) => s.bucket === 'rising').sort((a, b) => b.score - a.score)
  const established = scored
    .filter((s) => s.bucket === 'established')
    .sort((a, b) => b.score - a.score)

  // 60/40 mix capped at maxCandidates
  const cap = GITHUB_CONFIG.maxCandidates
  const targetRising = Math.round(cap * GITHUB_CONFIG.risingRatio)
  const targetEstablished = cap - targetRising

  const pickedRising = rising.slice(0, targetRising)
  const pickedEstablished = established.slice(0, targetEstablished)

  // Top-up if one bucket short
  const merged: ScoredRepo[] = [...pickedRising, ...pickedEstablished]
  if (merged.length < cap) {
    const remainder = [
      ...rising.slice(pickedRising.length),
      ...established.slice(pickedEstablished.length),
    ]
      .sort((a, b) => b.score - a.score)
      .slice(0, cap - merged.length)
    merged.push(...remainder)
  }

  // Final sort by score (mix the buckets)
  merged.sort((a, b) => b.score - a.score)

  logger.info(
    {
      candidates: candidates.length,
      afterDedup: fresh.length,
      shortlist: merged.length,
      rising: merged.filter((m) => m.bucket === 'rising').length,
      established: merged.filter((m) => m.bucket === 'established').length,
    },
    'GH shortlist built',
  )
  return merged
}
