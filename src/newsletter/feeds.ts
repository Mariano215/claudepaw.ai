import { logger } from '../logger.js'
import type { RawArticle, CategoryId } from './types.js'
import { FEEDS } from './config.js'

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    // Strip UTM parameters
    const keysToDelete: string[] = []
    for (const key of parsed.searchParams.keys()) {
      if (key.startsWith('utm_')) {
        keysToDelete.push(key)
      }
    }
    for (const key of keysToDelete) {
      parsed.searchParams.delete(key)
    }
    let result = parsed.origin + parsed.pathname
    const qs = parsed.searchParams.toString()
    if (qs) {
      result += '?' + qs
    }
    // Remove trailing slash
    result = result.replace(/\/$/, '')
    return result
  } catch {
    return url.replace(/\/$/, '')
  }
}

// ---------------------------------------------------------------------------
// Google News URL resolution
// ---------------------------------------------------------------------------

export function resolveGoogleNewsUrl(url: string): string {
  if (!url.includes('news.google.com/rss/articles/')) {
    return url
  }
  try {
    const marker = '/articles/'
    const idx = url.indexOf(marker)
    if (idx === -1) return url
    const encoded = url.slice(idx + marker.length).split('?')[0]
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
    const match = decoded.match(/https?:\/\/[^\s"'<>]+/)
    if (match) {
      return normalizeUrl(match[0])
    }
    return url
  } catch {
    return url
  }
}

// ---------------------------------------------------------------------------
// Strip HTML tags
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// XML tag extraction helpers (no external XML parser needed)
// ---------------------------------------------------------------------------

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(
    `<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`,
    'i',
  )
  const match = xml.match(regex)
  return match ? match[1].trim() : ''
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const regex = new RegExp(`<${tag}[^>]*?${attr}\\s*=\\s*["']([^"']+)["']`, 'i')
  const match = xml.match(regex)
  return match ? match[1].trim() : ''
}

function splitItems(xml: string, itemTag: string): string[] {
  const items: string[] = []
  const regex = new RegExp(`<${itemTag}[\\s>][\\s\\S]*?</${itemTag}>`, 'gi')
  let match: RegExpExecArray | null
  while ((match = regex.exec(xml)) !== null) {
    items.push(match[0])
  }
  return items
}

// ---------------------------------------------------------------------------
// RSS/Atom/RDF XML parser
// ---------------------------------------------------------------------------

export function parseRssXml(
  xml: string,
  feedUrl: string,
  category: CategoryId | 'google_news',
): RawArticle[] {
  const articles: RawArticle[] = []

  const isAtom = xml.includes('<feed') && xml.includes('xmlns="http://www.w3.org/2005/Atom"')

  if (isAtom) {
    const entries = splitItems(xml, 'entry')
    for (const entry of entries) {
      const title = stripHtml(extractTag(entry, 'title'))
      const url = extractAttr(entry, 'link', 'href') || extractTag(entry, 'link')
      const summary = stripHtml(
        extractTag(entry, 'summary') || extractTag(entry, 'content'),
      )
      const dateStr = extractTag(entry, 'updated') || extractTag(entry, 'published')
      const publishedAt = dateStr ? new Date(dateStr) : new Date()

      if (title && url) {
        articles.push({
          title,
          url: normalizeUrl(url),
          summary: summary.slice(0, 500),
          publishedAt,
          sourceFeed: feedUrl,
          sourceCategory: category,
        })
      }
    }
  } else {
    const items = splitItems(xml, 'item')
    for (const item of items) {
      const title = stripHtml(extractTag(item, 'title'))
      const url = extractTag(item, 'link') || extractAttr(item, 'item', 'rdf:about')
      const summary = stripHtml(
        extractTag(item, 'description') || extractTag(item, 'content:encoded'),
      )
      const dateStr =
        extractTag(item, 'pubDate') ||
        extractTag(item, 'dc:date') ||
        extractTag(item, 'published')
      const publishedAt = dateStr ? new Date(dateStr) : new Date()

      if (title && url) {
        articles.push({
          title,
          url: normalizeUrl(url),
          summary: summary.slice(0, 500),
          publishedAt,
          sourceFeed: feedUrl,
          sourceCategory: category,
        })
      }
    }
  }

  return articles
}

// ---------------------------------------------------------------------------
// Fetch a single feed
// ---------------------------------------------------------------------------

async function fetchFeed(
  feedUrl: string,
  category: CategoryId | 'google_news',
): Promise<RawArticle[]> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    const res = await fetch(feedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ClaudePaw-Newsletter/1.0 (+https://github.com/Mariano215/claudepaw.ai)',
        Accept: 'application/rss+xml, application/xml, text/xml, application/atom+xml',
      },
    })
    clearTimeout(timeout)

    if (!res.ok) {
      logger.warn({ feedUrl, status: res.status }, 'Feed fetch failed')
      return []
    }

    const xml = await res.text()
    let articles = parseRssXml(xml, feedUrl, category)

    if (category === 'google_news') {
      articles = articles.map((a) => ({
        ...a,
        url: resolveGoogleNewsUrl(a.url),
      }))
    }

    logger.debug({ feedUrl, count: articles.length }, 'Feed parsed')
    return articles
  } catch (err) {
    logger.warn({ feedUrl, err }, 'Feed fetch error')
    return []
  }
}

// ---------------------------------------------------------------------------
// Fetch all feeds
// ---------------------------------------------------------------------------

export async function fetchAllFeeds(): Promise<RawArticle[]> {
  const allArticles: RawArticle[] = []
  const feedEntries: Array<{ url: string; category: CategoryId | 'google_news' }> = []

  for (const [category, urls] of Object.entries(FEEDS)) {
    for (const url of urls) {
      feedEntries.push({ url, category: category as CategoryId | 'google_news' })
    }
  }

  const CONCURRENCY = 5
  for (let i = 0; i < feedEntries.length; i += CONCURRENCY) {
    const batch = feedEntries.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map((entry) => fetchFeed(entry.url, entry.category)),
    )
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allArticles.push(...result.value)
      }
    }
  }

  logger.info(
    { totalArticles: allArticles.length, totalFeeds: feedEntries.length },
    'All feeds fetched',
  )
  return allArticles
}
