import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { logger } from '../logger.js'
import { reportFeedItem } from '../dashboard.js'
import { checkAction, type PolicyDecision } from '../policy.js'
import {
  NEWSLETTER_CONFIG,
  getLookbackDays,
  LINKEDIN_NEWSLETTER_URL,
  LINKEDIN_NEWSLETTER_PUBLICATION_NAME,
  NEWSLETTER_BYLINE_NAME,
  NEWSLETTER_BYLINE_URL,
} from './config.js'
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
import type { HeroFallbackReason } from './hero.js'
import { renderNewsletter } from './renderer.js'
import { sendEmail } from '../google/gmail.js'
import { collectRepoCandidates, shortlistRepos } from './github-collector.js'
import { curateRepos } from './github-curator.js'
import { markReposSeen } from './github-dedup.js'
import { buildLinkedinBody, buildLinkedinPostPlain } from '../newsletter-linkedin/body-builder.js'
import { publishToLinkedin } from '../newsletter-linkedin/publisher.js'
import {
  saveEditionSnapshot,
  loadEditionSnapshot,
  defaultSnapshotPath,
} from '../newsletter-linkedin/snapshot.js'
import type { CategoryId, ScoredArticle, ScoredRepo, ExecutiveBrief } from './types.js'

export interface GenerateOptions {
  /** Skip sendEmail() and skip marking URLs/repos as seen. Useful for one-shot LinkedIn republish. */
  skipGmail?: boolean
  /** Bypass article + repo dedup filters. Use only for one-shot republish. */
  bypassDedup?: boolean
  /** Run the LinkedIn publisher at the end (after Gmail step). Off by default. */
  publishLinkedin?: boolean
  /** When publishLinkedin is true, drive the publisher in dry-run mode (save draft only). */
  linkedinDryRun?: boolean
  /**
   * Save a JSON snapshot of the fully-composed edition (brief + articles +
   * repos + hero metadata) after phase 7 so future runs can replay it
   * via loadSnapshotPath. `true` writes to the default path
   * (store/newsletter/snapshots/{editionId}.json); pass a string to override.
   */
  saveSnapshot?: boolean | string
  /**
   * When set, load a previously-saved edition snapshot from this path and
   * skip phases 1-7 entirely. Useful for iterating on the LinkedIn
   * publisher against known-good content without burning RSS/LLM cycles.
   */
  loadSnapshotPath?: string
  /**
   * Write the rendered HTML here and stop short of Gmail. Implies skipGmail +
   * bypassDedup, and suffixes the edition id and hero filename with '-preview'
   * so a fresh hero is generated and today's real edition row is untouched.
   */
  previewHtmlPath?: string
  /**
   * Preview runs skip Gmail by default. Set this to also email the preview
   * edition. Dedup marks stay off either way, so a preview never consumes
   * articles the next real edition would have carried.
   */
  previewEmail?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function computeEditionDate(): string {
  const d = new Date()
  return d.toISOString().slice(0, 10)
}

export function computeEditionId(dateStr: string): string {
  return `signal-${dateStr}`
}

// ---------------------------------------------------------------------------
// Init (called at startup)
// ---------------------------------------------------------------------------

export function initNewsletter(): void {
  createNewsletterTables()
  logger.info('Newsletter system initialized')
}

/**
 * Hero status for the run summary. heroImageSrc is the single source of truth:
 * empty means the email shipped with no banner, whatever failed upstream
 * (generation, missing fallback asset, or optimize). The reason is appended
 * when we have one.
 */
export function heroStatusLabel(
  heroImageSrc: string,
  reason?: HeroFallbackReason,
): string {
  if (heroImageSrc) return 'OK'
  return `MISSING${reason ? ` (${reason})` : ''}`
}

/**
 * social.post gate outcome for the LinkedIn newsletter leg. `deny` refuses
 * the publish outright; a pending decision parks it behind the card id in
 * the label; `allow` clears the publish to run.
 */
export function resolveLinkedinGate(decision: PolicyDecision): { publish: boolean; heldStatus?: string } {
  if (decision === 'deny') return { publish: false, heldStatus: 'REFUSED (policy)' }
  if (decision !== 'allow') return { publish: false, heldStatus: `HELD (card ${decision.slice('pending:'.length)})` }
  return { publish: true }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function generateAndSendNewsletter(
  chatId: string,
  sendFn: (chatId: string, text: string) => Promise<void>,
  opts: GenerateOptions = {},
): Promise<string> {
  if (opts.previewHtmlPath) {
    opts = { ...opts, skipGmail: !opts.previewEmail, bypassDedup: true }
  }
  let dateStr = computeEditionDate() + (opts.previewHtmlPath ? '-preview' : '')
  let editionId = computeEditionId(dateStr)
  let lookbackDays = getLookbackDays()
  logger.info({ opts }, 'Newsletter run options')

  logger.info({ editionId, lookbackDays }, 'Starting newsletter generation')
  reportFeedItem('content-researcher', 'Newsletter generation started', editionId)

  let accessibleByCategory: Record<CategoryId, ScoredArticle[]>
  let githubPicks: ScoredRepo[] = []
  let brief: ExecutiveBrief
  let imagePath: string
  let artDirection: string
  let heroFallbackReason: HeroFallbackReason | undefined

  if (opts.loadSnapshotPath) {
    // Replay path: skip phases 1-7, load fully-composed edition from disk.
    const snap = loadEditionSnapshot(opts.loadSnapshotPath)
    dateStr = snap.dateStr
    editionId = snap.editionId
    lookbackDays = snap.lookbackDays
    accessibleByCategory = snap.accessibleByCategory
    githubPicks = snap.githubPicks
    brief = snap.brief
    imagePath = snap.imagePath
    artDirection = snap.artDirection
    logger.info(
      {
        editionId,
        cyber: accessibleByCategory.cyber.length,
        ai: accessibleByCategory.ai.length,
        research: accessibleByCategory.research.length,
        github: githubPicks.length,
      },
      'Replaying edition from snapshot',
    )
  } else {
    // Fresh-fetch path: phases 1-7.
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

    // 4. Dedup against seen links (bypass for one-shot republish)
    const unseen = opts.bypassDedup ? scored : filterSeenArticles(scored)
    logger.info(
      { count: unseen.length, bypassed: !!opts.bypassDedup },
      'Articles after dedup pass',
    )

    // 5. Select top articles per category
    const selected = selectTopArticles(unseen, NEWSLETTER_CONFIG.perCategoryLimit)
    const allSelected = [...selected.cyber, ...selected.ai, ...selected.research]
    logger.info(
      {
        cyber: selected.cyber.length,
        ai: selected.ai.length,
        research: selected.research.length,
      },
      'Top articles selected',
    )

    if (allSelected.length === 0) {
      const msg = 'Newsletter: no articles passed filtering. Skipping edition.'
      logger.warn(msg)
      return msg
    }

    // 5b. Collect GitHub repo candidates and shortlist them.
    let githubShortlist: ScoredRepo[] = []
    try {
      const ghCandidates = await collectRepoCandidates()
      githubShortlist = shortlistRepos(ghCandidates, { bypassDedup: !!opts.bypassDedup })
    } catch (err) {
      logger.warn({ err }, 'GH candidate collection failed (non-fatal)')
    }

    // 6. Probe accessibility
    accessibleByCategory = {
      cyber: await probeArticles(selected.cyber),
      ai: await probeArticles(selected.ai),
      research: await probeArticles(selected.research),
    }
    const totalAccessible =
      accessibleByCategory.cyber.length +
      accessibleByCategory.ai.length +
      accessibleByCategory.research.length

    if (totalAccessible === 0) {
      const msg = 'Newsletter: all articles failed accessibility probe. Skipping edition.'
      logger.warn(msg)
      return msg
    }

    // 6b. LLM-curate GH picks (skip prober: GH URLs are reachable by definition)
    try {
      githubPicks = await curateRepos(githubShortlist)
    } catch (err) {
      logger.warn({ err }, 'GH curator failed (non-fatal) — section will render empty')
    }
    logger.info({ count: githubPicks.length }, 'GH picks finalized for edition')

    // 7. Generate executive brief (LLM-powered with heuristic fallback)
    const repoTitlesForBrief = githubPicks.map(
      (r) => `${r.fullName}: ${r.whyItMatters}`,
    )
    brief = await generateExecutiveBrief(accessibleByCategory, repoTitlesForBrief)
    logger.info({ themes: brief.topThemes }, 'Executive brief generated')

    // 8. Generate hero image
    const heroOut = await generateHeroImage(brief.topThemes, dateStr, brief.heroScene)
    imagePath = heroOut.imagePath
    artDirection = heroOut.artDirection
    heroFallbackReason = heroOut.fallbackReason
    if (heroFallbackReason) {
      logger.error(
        { reason: heroFallbackReason },
        'Hero image unavailable -- edition will send without a banner',
      )
    }

    // Save snapshot for future replay (skip on snapshot-load runs to avoid overwriting source)
    if (opts.saveSnapshot) {
      const snapshotPath =
        typeof opts.saveSnapshot === 'string'
          ? opts.saveSnapshot
          : defaultSnapshotPath(editionId)
      saveEditionSnapshot(
        {
          editionId,
          dateStr,
          lookbackDays,
          brief,
          accessibleByCategory,
          githubPicks,
          imagePath,
          artDirection,
        },
        snapshotPath,
      )
    }
  }

  const heroImageSrc = await optimizeForEmail(imagePath)

  // 9. Load template and render HTML
  const templatePath = NEWSLETTER_CONFIG.templatePath
  if (!existsSync(templatePath)) {
    throw new Error(`Newsletter template not found at ${templatePath}`)
  }
  const template = readFileSync(templatePath, 'utf-8')

  const linkedinPost = buildLinkedinPostPlain({
    brief,
    articles: accessibleByCategory,
    github: githubPicks,
    subscribeUrl: LINKEDIN_NEWSLETTER_URL,
    byline: NEWSLETTER_BYLINE_NAME
      ? { name: NEWSLETTER_BYLINE_NAME, url: NEWSLETTER_BYLINE_URL || undefined }
      : undefined,
  })

  const html = renderNewsletter(template, {
    articles: accessibleByCategory,
    github: githubPicks,
    executiveInsight: brief.insight,
    executiveImplication: brief.implication,
    heroImageSrc,
    heroArtDirection: artDirection,
    lookbackDays,
    linkedinPost,
  })

  if (opts.previewHtmlPath) {
    writeFileSync(opts.previewHtmlPath, html)
    logger.info({ path: opts.previewHtmlPath }, 'Preview HTML written')
  }

  // 10. Send email (skip on republish flows)
  let sendOk = true
  if (!opts.skipGmail) {
    const sendResult = await sendEmail({
      to: NEWSLETTER_CONFIG.recipientEmail,
      subject: `The Signal - ${dateStr}`,
      htmlBody: html,
    })
    sendOk = sendResult.success

    // 11. Mark URLs as seen. Never on a preview: a preview must not consume
    // articles that the next real edition would otherwise carry.
    if (!opts.previewHtmlPath) {
    const allAccessibleUrls = [
      ...accessibleByCategory.cyber,
      ...accessibleByCategory.ai,
      ...accessibleByCategory.research,
    ].map((a) => a.url)
    markUrlsSeen(allAccessibleUrls, dateStr)

    // 11b. Mark GitHub repos as seen (90-day rolling window, re-allow on new release)
    if (githubPicks.length > 0) {
      markReposSeen(githubPicks, dateStr)
    }
    }
  } else {
    logger.info('skipGmail: skipping sendEmail + markUrlsSeen + markReposSeen')
  }

  // 12. Prune old seen links
  pruneOldLinks(365)

  // 13. Record edition (idempotent INSERT OR REPLACE — safe on re-runs)
  recordEdition({
    id: editionId,
    date: dateStr,
    lookback_days: lookbackDays,
    articles_cyber: accessibleByCategory.cyber.length,
    articles_ai: accessibleByCategory.ai.length,
    articles_research: accessibleByCategory.research.length,
    articles_github: githubPicks.length,
    hero_path: imagePath,
    html_bytes: Buffer.byteLength(html, 'utf-8'),
    sent_at: !opts.skipGmail && sendOk ? Date.now() : null,
    recipient: NEWSLETTER_CONFIG.recipientEmail,
  })

  // 14b. LinkedIn Newsletter publish (gated by opts.publishLinkedin and social.post)
  let linkedinResult: { ok: boolean; publishedUrl?: string; errorMessage?: string } | null = null
  // The LinkedIn newsletter publish is a social.post side effect that never
  // touches the social_posts table, so it needs its own gate.
  const linkedinDecision = opts.publishLinkedin
    ? await checkAction('default', 'social.post', 'social-writer', { edition_id: editionId, surface: 'linkedin-newsletter' })
    : 'deny'
  const linkedinGate = resolveLinkedinGate(linkedinDecision)
  if (opts.publishLinkedin && linkedinGate.publish) {
    try {
      const linkedinBody = buildLinkedinBody({
        brief,
        articles: accessibleByCategory,
        github: githubPicks,
        subscribeUrl: LINKEDIN_NEWSLETTER_URL,
        byline: NEWSLETTER_BYLINE_NAME
          ? { name: NEWSLETTER_BYLINE_NAME, url: NEWSLETTER_BYLINE_URL || undefined }
          : undefined,
      })
      const result = await publishToLinkedin(
        {
          editionId,
          title: linkedinBody.title,
          coverImagePath: imagePath,
          delta: linkedinBody.delta,
          newsletterName: LINKEDIN_NEWSLETTER_PUBLICATION_NAME,
        },
        { dryRun: !!opts.linkedinDryRun },
      )
      linkedinResult = {
        ok: result.ok,
        publishedUrl: result.publishedUrl,
        errorMessage: result.errorMessage,
      }
      logger.info(
        { ok: result.ok, step: result.step, publishedUrl: result.publishedUrl, durationMs: result.durationMs },
        'LinkedIn publish finished',
      )
    } catch (err) {
      logger.error({ err }, 'LinkedIn publish threw (non-fatal)')
      linkedinResult = {
        ok: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // 14. Report to dashboard
  const gmailStatus = opts.skipGmail ? 'SKIPPED' : sendOk ? 'OK' : 'FAILED'
  const linkedinStatus = !opts.publishLinkedin
    ? 'OFF'
    : linkedinGate.heldStatus
      ? linkedinGate.heldStatus
      : linkedinResult?.ok
        ? opts.linkedinDryRun
          ? 'DRY-DRAFT'
          : `OK${linkedinResult.publishedUrl ? ` ${linkedinResult.publishedUrl}` : ''}`
        : `FAILED${linkedinResult?.errorMessage ? ` (${linkedinResult.errorMessage})` : ''}`
  const heroStatus = heroStatusLabel(heroImageSrc, heroFallbackReason)
  const summary =
    `The Signal ${dateStr}: ${accessibleByCategory.cyber.length} cyber, ` +
    `${accessibleByCategory.ai.length} AI, ${accessibleByCategory.research.length} research, ` +
    `${githubPicks.length} repos. ` +
    `Hero: ${heroStatus}. Gmail: ${gmailStatus}. LinkedIn: ${linkedinStatus}.`

  reportFeedItem('content-researcher', 'newsletter-sent', summary)

  // 15. Notify user
  try {
    await sendFn(chatId, summary)
  } catch {
    // Notification failure is non-critical
  }

  logger.info(
    {
      editionId,
      gmailOk: !opts.skipGmail && sendOk,
      linkedinOk: opts.publishLinkedin ? !!linkedinResult?.ok : null,
    },
    'Newsletter generation complete',
  )
  return summary
}
