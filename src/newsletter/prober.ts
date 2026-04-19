import { logger } from '../logger.js'
import {
  PAYWALL_HOSTS,
  PAYWALL_MARKERS,
  BLOCK_MARKERS,
  NEWSLETTER_CONFIG,
} from './config.js'
import type { ScoredArticle } from './types.js'

// ---------------------------------------------------------------------------
// Paywall host check
// ---------------------------------------------------------------------------

export function isPaywallHost(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return PAYWALL_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// HTML content checks
// ---------------------------------------------------------------------------

export function checkPaywallMarkers(html: string): boolean {
  const lower = html.toLowerCase()
  return PAYWALL_MARKERS.some((marker) => lower.includes(marker))
}

export function checkBlockMarkers(html: string): boolean {
  const lower = html.toLowerCase()
  return BLOCK_MARKERS.some((marker) => lower.includes(marker))
}

// ---------------------------------------------------------------------------
// Probe a single URL
// ---------------------------------------------------------------------------

export async function probeUrl(url: string): Promise<boolean> {
  if (isPaywallHost(url)) {
    logger.debug({ url }, 'Skipping paywall host')
    return false
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), NEWSLETTER_CONFIG.probeTimeoutMs)

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    })
    clearTimeout(timeout)

    // Only reject on hard 4xx client errors (not 403 which is often bot detection)
    if (res.status >= 400 && res.status !== 403) {
      logger.debug({ url, status: res.status }, 'Probe failed: client error')
      return false
    }

    // If we got a 403, keep the article -- it's likely Cloudflare/bot protection
    // and the link is still valid for human readers
    if (res.status === 403) {
      logger.debug({ url }, 'Probe got 403 (likely bot protection), keeping article')
      return true
    }

    // Read only first 64KB
    const reader = res.body?.getReader()
    if (!reader) return true // no body = keep article

    let html = ''
    const decoder = new TextDecoder()
    const MAX_BYTES = 65_536

    while (html.length < MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      html += decoder.decode(value, { stream: true })
    }
    reader.cancel().catch(() => {})

    if (checkPaywallMarkers(html)) {
      logger.debug({ url }, 'Probe failed: paywall marker detected')
      return false
    }

    // Only block on strong block markers, not generic "access denied"
    if (checkBlockMarkers(html)) {
      logger.debug({ url }, 'Probe failed: block marker detected')
      return false
    }

    return true
  } catch (err) {
    // Network errors (timeout, DNS, etc.) -- keep the article
    // The link might still be valid for human readers
    logger.debug({ url, err }, 'Probe failed: network error, keeping article')
    return true
  }
}

// ---------------------------------------------------------------------------
// Probe all articles (filter out inaccessible ones)
// ---------------------------------------------------------------------------

export async function probeArticles(
  articles: ScoredArticle[],
): Promise<ScoredArticle[]> {
  const CONCURRENCY = 5
  const accessible: ScoredArticle[] = []

  for (let i = 0; i < articles.length; i += CONCURRENCY) {
    const batch = articles.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map(async (article) => {
        const ok = await probeUrl(article.url)
        return { article, ok }
      }),
    )

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.ok) {
        accessible.push(result.value.article)
      }
    }
  }

  logger.info(
    { input: articles.length, accessible: accessible.length },
    'Accessibility probe complete',
  )
  return accessible
}
