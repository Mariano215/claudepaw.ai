import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { normalizeUrl, parseRssXml, resolveGoogleNewsUrl } from '../../newsletter/feeds.js'

interface QuerySpec {
  id: string
  label: string
  query: string
}

interface CompetitiveArticle {
  title: string
  url: string
  domain: string
  published_at: string
  summary: string
  query_id: string
  query_label: string
  official_source: boolean
}

interface CompetitiveCollectorRaw {
  window_days: number
  query_count: number
  queries: Array<{
    id: string
    label: string
    query: string
    feed_url: string
    article_count: number
  }>
  articles: CompetitiveArticle[]
}

const DEFAULT_WINDOW_DAYS = 14
const MAX_ARTICLES_PER_QUERY = 4
const MAX_TOTAL_ARTICLES = 12

const QUERIES: QuerySpec[] = [
  {
    id: 'platform-moves',
    label: 'Major platform moves',
    query: '("AI agent" OR "agent builder" OR AgentKit OR "Agent Builder") (OpenAI OR Anthropic OR Microsoft OR Telegram)',
  },
  {
    id: 'oss-competitors',
    label: 'Open-source competitor launches',
    query: '("OpenClaw" OR "Nanobot AI" OR "agent framework" OR "open source AI agent")',
  },
  {
    id: 'agent-governance',
    label: 'Agent governance and security',
    query: '("agent governance" OR "AI agent security" OR "OWASP agentic AI")',
  },
]

const OFFICIAL_DOMAINS = [
  'openai.com',
  'anthropic.com',
  'telegram.org',
  'microsoft.com',
  'opensource.microsoft.com',
  'github.com',
]

function buildGoogleNewsFeedUrl(query: string, windowDays: number): string {
  const params = new URLSearchParams({
    q: `${query} when:${windowDays}d`,
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  })
  return `https://news.google.com/rss/search?${params.toString()}`
}

function parseWindowDays(args?: Record<string, unknown>): number {
  const raw = Number(args?.window_days ?? DEFAULT_WINDOW_DAYS)
  if (!Number.isFinite(raw)) return DEFAULT_WINDOW_DAYS
  return Math.max(1, Math.min(30, Math.round(raw)))
}

function domainFor(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return ''
  }
}

function isOfficialSource(domain: string): boolean {
  return OFFICIAL_DOMAINS.some(
    official => domain === official || domain.endsWith(`.${official}`),
  )
}

async function fetchQuery(
  spec: QuerySpec,
  windowDays: number,
): Promise<{ meta: CompetitiveCollectorRaw['queries'][number]; articles: CompetitiveArticle[]; error?: string }> {
  const feedUrl = buildGoogleNewsFeedUrl(spec.query, windowDays)
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    const res = await fetch(feedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ClaudePaw-CompetitiveWatch/1.0',
        Accept: 'application/rss+xml, application/xml, text/xml, application/atom+xml',
      },
    })
    clearTimeout(timeout)

    if (!res.ok) {
      return {
        meta: { id: spec.id, label: spec.label, query: spec.query, feed_url: feedUrl, article_count: 0 },
        articles: [],
        error: `HTTP ${res.status}`,
      }
    }

    const xml = await res.text()
    const parsed = parseRssXml(xml, feedUrl, 'google_news')
      .map((article) => {
        const url = normalizeUrl(resolveGoogleNewsUrl(article.url))
        const domain = domainFor(url)
        return {
          title: article.title,
          url,
          domain,
          published_at: article.publishedAt instanceof Date && !Number.isNaN(article.publishedAt.getTime())
            ? article.publishedAt.toISOString()
            : '',
          summary: article.summary.slice(0, 280),
          query_id: spec.id,
          query_label: spec.label,
          official_source: isOfficialSource(domain),
        } satisfies CompetitiveArticle
      })
      .filter(article => article.title && article.url)
      .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))

    return {
      meta: {
        id: spec.id,
        label: spec.label,
        query: spec.query,
        feed_url: feedUrl,
        article_count: Math.min(parsed.length, MAX_ARTICLES_PER_QUERY),
      },
      articles: parsed.slice(0, MAX_ARTICLES_PER_QUERY),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn({ err, queryId: spec.id }, '[paws] Competitive collector feed fetch failed')
    return {
      meta: { id: spec.id, label: spec.label, query: spec.query, feed_url: feedUrl, article_count: 0 },
      articles: [],
      error: msg,
    }
  }
}

export const competitiveLandscapeCollector: Collector = async (ctx) => {
  const windowDays = parseWindowDays(ctx.args)
  const errors: string[] = []
  const seenUrls = new Set<string>()
  const articles: CompetitiveArticle[] = []
  const queries: CompetitiveCollectorRaw['queries'] = []

  const results = await Promise.all(QUERIES.map(query => fetchQuery(query, windowDays)))
  for (const result of results) {
    queries.push(result.meta)
    if (result.error) {
      errors.push(`${result.meta.id}: ${result.error}`)
    }
    for (const article of result.articles) {
      if (seenUrls.has(article.url)) continue
      seenUrls.add(article.url)
      articles.push(article)
    }
  }

  articles.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))

  return {
    raw_data: {
      window_days: windowDays,
      query_count: queries.length,
      queries,
      articles: articles.slice(0, MAX_TOTAL_ARTICLES),
    } satisfies CompetitiveCollectorRaw,
    collected_at: Date.now(),
    collector: 'competitive-landscape',
    errors: errors.length ? errors : undefined,
  }
}
