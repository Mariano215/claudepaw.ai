import { readFileSync, existsSync } from 'node:fs'
import { logger } from '../logger.js'
import { reportFeedItem } from '../dashboard.js'
import { NEWSLETTER_CONFIG, getLookbackDays } from './config.js'
import { fetchAllFeeds } from './feeds.js'
import { scoreAllArticles, selectTopArticles } from './scorer.js'
import {
  createNewsletterTables,
  filterSeenArticles,
  markUrlsSeen,
  pruneOldLinks,
  recordEdition,
} from './dedup.js'
import { probeArticles } from './prober.js'
import { generateExecutiveBrief } from './brief.js'
import { generateHeroImage, optimizeForEmail } from './hero.js'
import { renderNewsletter } from './renderer.js'
import { sendEmail } from '../google/gmail.js'
import type { CategoryId, ScoredArticle } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function computeEditionDate(): string {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}

export function computeEditionId(dateStr: string): string {
  return `asymmetry-${dateStr}`
}

// ---------------------------------------------------------------------------
// Init (called at startup)
// ---------------------------------------------------------------------------

export function initNewsletter(): void {
  createNewsletterTables()
  logger.info('Newsletter system initialized')
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function generateAndSendNewsletter(
  chatId: string,
  sendFn: (chatId: string, text: string) => Promise<void>,
): Promise<string> {
  const dateStr = computeEditionDate()
  const editionId = computeEditionId(dateStr)
  const lookbackDays = getLookbackDays()

  logger.info({ editionId, lookbackDays }, 'Starting newsletter generation')
  reportFeedItem('scout', 'Newsletter generation started', editionId)

  // 1. Fetch all RSS feeds
  const rawArticles = await fetchAllFeeds()
  logger.info({ count: rawArticles.length }, 'Raw articles fetched')

  // 2. Filter by lookback window
  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000)
  const recentArticles = rawArticles.filter((a) => a.publishedAt >= cutoff)
  logger.info(
    { count: recentArticles.length, lookbackDays },
    'Articles within lookback window',
  )

  // 3. Score and categorize
  const scored = scoreAllArticles(recentArticles)
  logger.info({ count: scored.length }, 'Articles scored')

  // 4. Dedup against seen links
  const unseen = filterSeenArticles(scored)
  logger.info({ count: unseen.length }, 'Unseen articles after dedup')

  // 5. Select top articles per category
  const selected = selectTopArticles(unseen, NEWSLETTER_CONFIG.perCategoryLimit)
  const allSelected = [
    ...selected.cyber,
    ...selected.ai,
    ...selected.research,
  ]
  logger.info(
    {
      cyber: selected.cyber.length,
      ai: selected.ai.length,
      research: selected.research.length,
    },
    'Top articles selected',
  )

  if (allSelected.length === 0) {
    const msg =
      'Newsletter: no articles passed filtering. Skipping edition.'
    logger.warn(msg)
    return msg
  }

  // 6. Probe accessibility
  const accessibleByCategory: Record<CategoryId, ScoredArticle[]> = {
    cyber: await probeArticles(selected.cyber),
    ai: await probeArticles(selected.ai),
    research: await probeArticles(selected.research),
  }
  const totalAccessible =
    accessibleByCategory.cyber.length +
    accessibleByCategory.ai.length +
    accessibleByCategory.research.length

  if (totalAccessible === 0) {
    const msg =
      'Newsletter: all articles failed accessibility probe. Skipping edition.'
    logger.warn(msg)
    return msg
  }

  // 7. Generate executive brief (LLM-powered with heuristic fallback)
  const brief = await generateExecutiveBrief(accessibleByCategory)
  logger.info({ themes: brief.topThemes }, 'Executive brief generated')

  // 8. Generate hero image
  const { imagePath, artDirection } = await generateHeroImage(
    brief.topThemes,
    dateStr,
  )
  const heroImageSrc = await optimizeForEmail(imagePath)

  // 9. Load template and render HTML
  const templatePath = NEWSLETTER_CONFIG.templatePath
  if (!existsSync(templatePath)) {
    throw new Error(`Newsletter template not found at ${templatePath}`)
  }
  const template = readFileSync(templatePath, 'utf-8')

  const html = renderNewsletter(template, {
    articles: accessibleByCategory,
    executiveInsight: brief.insight,
    executiveImplication: brief.implication,
    heroImageSrc,
    heroArtDirection: artDirection,
    lookbackDays,
  })

  // 10. Send email
  const sendResult = await sendEmail({
    to: NEWSLETTER_CONFIG.recipientEmail,
    subject: 'ClaudePaw Intelligence Brief - AI & Cybersecurity',
    htmlBody: html,
  })

  // 11. Mark URLs as seen
  const allAccessibleUrls = [
    ...accessibleByCategory.cyber,
    ...accessibleByCategory.ai,
    ...accessibleByCategory.research,
  ].map((a) => a.url)
  markUrlsSeen(allAccessibleUrls, dateStr)

  // 12. Prune old seen links
  pruneOldLinks(365)

  // 13. Record edition
  recordEdition({
    id: editionId,
    date: dateStr,
    lookback_days: lookbackDays,
    articles_cyber: accessibleByCategory.cyber.length,
    articles_ai: accessibleByCategory.ai.length,
    articles_research: accessibleByCategory.research.length,
    hero_path: imagePath,
    html_bytes: Buffer.byteLength(html, 'utf-8'),
    sent_at: sendResult.success ? Date.now() : null,
    recipient: NEWSLETTER_CONFIG.recipientEmail,
  })

  // 14. Report to dashboard
  const summary =
    `Newsletter ${dateStr}: ${accessibleByCategory.cyber.length} cyber, ` +
    `${accessibleByCategory.ai.length} AI, ${accessibleByCategory.research.length} research. ` +
    `Send: ${sendResult.success ? 'OK' : 'FAILED'}`

  reportFeedItem('scout', 'newsletter-sent', summary)

  // 15. Notify user
  try {
    await sendFn(chatId, summary)
  } catch {
    // Notification failure is non-critical
  }

  logger.info(
    { editionId, success: sendResult.success },
    'Newsletter generation complete',
  )
  return summary
}
