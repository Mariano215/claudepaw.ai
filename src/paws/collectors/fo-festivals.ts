// src/paws/collectors/fo-festivals.ts
//
// Observe-phase collector for fo-festival-tracker. It absorbs the deleted
// fop-weekly-festival-scan cron job: same sources, one run a week instead of
// two, and the LLM only judges fit rather than going looking.
//
// Why Google News RSS and not FilmFreeway: filmfreeway.com/festivals answers
// HTTP 403 behind Cloudflare for any non-browser client, and the .json path
// returns a challenge page, so there is nothing deterministic to fetch there.
// The Example Film tracker sheet supplies the duplicate suppression the old scan
// prompt asked the agent to do by eye.
import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'
import { normalizeUrl, parseRssXml, resolveGoogleNewsUrl } from '../../newsletter/feeds.js'
import { readExample FilmFestivalRows } from '../../projects/example-company/task-context.js'

const WINDOW_DAYS = 14
const FEED_TIMEOUT_MS = 15_000
const MAX_PER_QUERY = 6
const MAX_TOTAL = 15

// One query per phrase the two old prompts used.
const QUERIES: Array<{ id: string; query: string }> = [
  { id: 'submissions-open', query: '"film festival" ("submissions open" OR "call for entries") 2026' },
  { id: 'deadlines', query: '"film festival" "submission deadline" 2026' },
  { id: 'short-film', query: '"short film festival" (submissions OR deadline) 2026' },
  { id: 'thriller-drama', query: '(thriller OR drama OR horror) "short film" festival submissions 2026' },
]

interface Candidate {
  id: string
  title: string
  url: string
  domain: string
  published_at: string
  summary: string
  query_id: string
  seen: boolean
}

function feedUrl(query: string): string {
  const params = new URLSearchParams({
    q: `${query} when:${WINDOW_DAYS}d`, hl: 'en-US', gl: 'US', ceid: 'US:en',
  })
  return `https://news.google.com/rss/search?${params.toString()}`
}

function domainFor(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' }
}

/** Ids reported by the last completed cycle. This is the seen watermark: it
 *  needs no new column, because the engine already stores findings per cycle. */
function previousIds(pawId: string): Set<string> {
  try {
    const row = getDb().prepare(
      `SELECT findings FROM paw_cycles WHERE paw_id = ? AND phase = 'completed'
         ORDER BY started_at DESC LIMIT 1`,
    ).get(pawId) as { findings: string } | undefined
    if (!row?.findings) return new Set()
    const parsed = JSON.parse(row.findings) as Array<{ id?: string }>
    return new Set(parsed.map(f => f.id).filter((id): id is string => Boolean(id)))
  } catch (err) {
    logger.warn({ err, pawId }, '[fo-festivals] could not read the previous cycle findings')
    return new Set()
  }
}

async function fetchQuery(spec: { id: string; query: string }): Promise<{ items: Candidate[]; error?: string }> {
  const url = feedUrl(spec.query)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ClaudePaw-FestivalTracker/1.0',
        Accept: 'application/rss+xml, application/xml, text/xml, application/atom+xml',
      },
    })
    if (!res.ok) return { items: [], error: `${spec.id}: HTTP ${res.status}` }
    const xml = await res.text()
    const items = parseRssXml(xml, url, 'google_news')
      .map((a) => {
        const link = normalizeUrl(resolveGoogleNewsUrl(a.url))
        return {
          id: link,
          title: a.title,
          url: link,
          domain: domainFor(link),
          published_at: a.publishedAt instanceof Date && !Number.isNaN(a.publishedAt.getTime())
            ? a.publishedAt.toISOString() : '',
          summary: a.summary.slice(0, 280),
          query_id: spec.id,
          seen: false,
        } satisfies Candidate
      })
      .filter(c => c.title && c.url)
      .slice(0, MAX_PER_QUERY)
    return { items }
  } catch (err) {
    return { items: [], error: `${spec.id}: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    clearTimeout(timer)
  }
}

export const foFestivalsCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const seen = previousIds(ctx.pawId)

  let trackerRows: string[][] = []
  try {
    trackerRows = await readExample FilmFestivalRows()
  } catch (err) {
    errors.push(`tracker sheet: ${err instanceof Error ? err.message : String(err)}`)
  }

  const results = await Promise.all(QUERIES.map(fetchQuery))
  const byId = new Map<string, Candidate>()
  for (const r of results) {
    if (r.error) errors.push(r.error)
    for (const item of r.items) {
      if (byId.has(item.id)) continue
      byId.set(item.id, { ...item, seen: seen.has(item.id) })
    }
  }
  const candidates = [...byId.values()]
    .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))
    .slice(0, MAX_TOTAL)

  logger.info(
    { pawId: ctx.pawId, candidates: candidates.length, newOnes: candidates.filter(c => !c.seen).length, trackerRows: trackerRows.length },
    '[fo-festivals] collect complete',
  )

  return {
    raw_data: {
      window_days: WINDOW_DAYS,
      queries: QUERIES.map(q => q.id),
      tracker_rows: trackerRows,
      candidates,
      new_count: candidates.filter(c => !c.seen).length,
    },
    collected_at: Date.now(),
    collector: 'fo-festivals',
    errors: errors.length ? errors : undefined,
  }
}
