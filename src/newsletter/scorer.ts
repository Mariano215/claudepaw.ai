import { CYBER_HINTS, AI_HINTS, RESEARCH_HINTS, BLOCK_TERMS } from './config.js'
import type { RawArticle, ScoredArticle, CategoryId } from './types.js'

// ---------------------------------------------------------------------------
// Block term filtering
// ---------------------------------------------------------------------------

export function isBlocked(article: RawArticle): boolean {
  const text = `${article.title} ${article.summary}`.toLowerCase()
  return BLOCK_TERMS.some((term) => text.includes(term))
}

// ---------------------------------------------------------------------------
// Extract domain from URL
// ---------------------------------------------------------------------------

function extractDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname
    return hostname.replace(/^www\./, '')
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Score an article against a category's hint list
// ---------------------------------------------------------------------------

function computeHintScore(text: string, hints: string[]): number {
  let score = 0
  const lower = text.toLowerCase()
  for (const hint of hints) {
    if (lower.includes(hint)) {
      // Multi-word hints get +2, single-word get +1
      score += hint.includes(' ') || hint.includes('-') ? 2 : 1
    }
  }
  return score
}

function computeRecencyBonus(publishedAt: Date): number {
  const hoursOld = (Date.now() - publishedAt.getTime()) / (1000 * 60 * 60)
  return Math.max(0, 168 - hoursOld) / 24
}

export function scoreArticle(article: RawArticle, category: CategoryId): number {
  const text = `${article.title} ${article.summary}`
  const hints =
    category === 'cyber' ? CYBER_HINTS
    : category === 'ai' ? AI_HINTS
    : RESEARCH_HINTS

  const hintScore = computeHintScore(text, hints)
  const recencyBonus = computeRecencyBonus(article.publishedAt)
  return hintScore + recencyBonus
}

// ---------------------------------------------------------------------------
// Categorize a Google News article by keyword match
// ---------------------------------------------------------------------------

export function categorizeGoogleNewsArticle(article: RawArticle): CategoryId {
  const text = `${article.title} ${article.summary}`
  const cyberScore = computeHintScore(text, CYBER_HINTS)
  const aiScore = computeHintScore(text, AI_HINTS)
  const researchScore = computeHintScore(text, RESEARCH_HINTS)

  if (cyberScore >= aiScore && cyberScore >= researchScore && cyberScore > 0) return 'cyber'
  if (aiScore >= cyberScore && aiScore >= researchScore && aiScore > 0) return 'ai'
  return 'research'
}

// ---------------------------------------------------------------------------
// Score and categorize all articles
// ---------------------------------------------------------------------------

export function scoreAllArticles(articles: RawArticle[]): ScoredArticle[] {
  const scored: ScoredArticle[] = []

  for (const article of articles) {
    if (isBlocked(article)) continue

    let category: CategoryId
    if (article.sourceCategory === 'google_news') {
      category = categorizeGoogleNewsArticle(article)
    } else {
      category = article.sourceCategory as CategoryId
    }

    const score = scoreArticle(article, category)

    scored.push({
      ...article,
      score,
      category,
      sourceDomain: extractDomain(article.url),
    })
  }

  return scored
}

// ---------------------------------------------------------------------------
// Select top N articles per category
// ---------------------------------------------------------------------------

export function selectTopArticles(
  articles: ScoredArticle[],
  perCategoryLimit: number,
): Record<CategoryId, ScoredArticle[]> {
  const grouped: Record<CategoryId, ScoredArticle[]> = {
    cyber: [],
    ai: [],
    research: [],
  }

  for (const article of articles) {
    grouped[article.category].push(article)
  }

  for (const category of Object.keys(grouped) as CategoryId[]) {
    grouped[category].sort((a, b) => b.score - a.score)
    grouped[category] = grouped[category].slice(0, perCategoryLimit)
  }

  return grouped
}
