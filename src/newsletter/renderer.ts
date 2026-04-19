import type { ScoredArticle, CategoryId } from './types.js'

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Google News RSS summaries often contain embedded <a> tags pointing to the
// original source. Stripping tags before escaping keeps the clean text.
function stripHtmlTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Single article item HTML
// ---------------------------------------------------------------------------

export function renderArticleItem(article: ScoredArticle): string {
  const title = escapeHtml(stripHtmlTags(article.title))
  const summary = escapeHtml(stripHtmlTags(article.summary))
  const domain = escapeHtml(article.sourceDomain)
  const url = escapeHtml(article.url)

  return `
    <div style="margin-bottom:16px;padding-left:12px;border-left:3px solid #1a73e8;">
      <a href="${url}" target="_blank" style="color:#1a73e8;text-decoration:none;font-weight:600;font-size:14px;">${title}</a>
      <div style="color:#444;font-size:13px;margin-top:4px;line-height:1.5;">${summary}</div>
      <div style="color:#888;font-size:11px;margin-top:4px;">${domain}</div>
    </div>`
}

// ---------------------------------------------------------------------------
// Render all items for a category
// ---------------------------------------------------------------------------

function renderCategoryItems(articles: ScoredArticle[]): string {
  if (articles.length === 0) {
    return '<p style="color:#888;font-style:italic;margin:0;">No articles in this category for this edition.</p>'
  }
  return articles.map(renderArticleItem).join('\n')
}

// Replace a {{#HERO}}...{{/HERO}} block in the template. Pass empty string
// to strip the block entirely when there's no hero image to show.
function replaceConditionalBlock(
  template: string,
  name: string,
  inner: string,
): string {
  const pattern = new RegExp(
    `\\{\\{#${name}\\}\\}([\\s\\S]*?)\\{\\{/${name}\\}\\}`,
    'g',
  )
  return template.replace(pattern, inner ? '$1' : '')
}

// ---------------------------------------------------------------------------
// Compute report window string
// ---------------------------------------------------------------------------

function computeReportWindow(lookbackDays: number): string {
  const end = new Date()
  const start = new Date(end.getTime() - lookbackDays * 86_400_000)
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  return `${fmt(start)} - ${fmt(end)}`
}

// ---------------------------------------------------------------------------
// Get weekday name
// ---------------------------------------------------------------------------

function getWeekday(): string {
  return new Date().toLocaleDateString('en-US', { weekday: 'long' })
}

// ---------------------------------------------------------------------------
// Full newsletter renderer
// ---------------------------------------------------------------------------

export interface RenderOptions {
  articles: Record<CategoryId, ScoredArticle[]>
  executiveInsight: string
  executiveImplication: string
  heroImageSrc: string
  heroArtDirection: string
  lookbackDays: number
}

export function renderNewsletter(template: string, opts: RenderOptions): string {
  const cyberHtml = renderCategoryItems(opts.articles.cyber)
  const aiHtml = renderCategoryItems(opts.articles.ai)
  const researchHtml = renderCategoryItems(opts.articles.research)
  const reportWindow = computeReportWindow(opts.lookbackDays)
  const weekday = getWeekday()

  let html = template
  html = replaceConditionalBlock(html, 'HERO', opts.heroImageSrc)
  html = html.replace(/\{\{REPORT_WINDOW\}\}/g, escapeHtml(reportWindow))
  html = html.replace(/\{\{LOOKBACK_DAYS\}\}/g, String(opts.lookbackDays))
  html = html.replace(/\{\{RUN_WEEKDAY\}\}/g, escapeHtml(weekday))
  html = html.replace(/\{\{EXECUTIVE_INSIGHT\}\}/g, escapeHtml(opts.executiveInsight))
  html = html.replace(/\{\{EXECUTIVE_IMPLICATION\}\}/g, escapeHtml(opts.executiveImplication))
  html = html.replace(/\{\{CYBER_ITEMS\}\}/g, cyberHtml)
  html = html.replace(/\{\{AI_ITEMS\}\}/g, aiHtml)
  html = html.replace(/\{\{RESEARCH_ITEMS\}\}/g, researchHtml)
  html = html.replace(/\{\{HERO_IMAGE_SRC\}\}/g, opts.heroImageSrc)
  html = html.replace(/\{\{HERO_ART_DIRECTION\}\}/g, escapeHtml(opts.heroArtDirection))

  return html
}
