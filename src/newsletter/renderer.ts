import type { ScoredArticle, CategoryId, ScoredRepo, RepoTag } from './types.js'

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
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FAFF}]/gu, '')
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

// ---------------------------------------------------------------------------
// GitHub repo item rendering
// ---------------------------------------------------------------------------

const REPO_TAG_COLORS: Record<RepoTag, string> = {
  agentic: '#6b21a8',
  ai: '#1a73e8',
  cyber: '#dc2626',
}

const REPO_TAG_LABELS: Record<RepoTag, string> = {
  agentic: 'Agentic',
  ai: 'AI',
  cyber: 'Cyber',
}

function relativeTime(d: Date): string {
  const ms = Date.now() - d.getTime()
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  return `${days}d ago`
}

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function renderRepoItem(repo: ScoredRepo): string {
  const name = escapeHtml(repo.fullName)
  const url = escapeHtml(repo.url)
  const blurb = escapeHtml(stripHtmlTags(repo.whyItMatters || ''))
  const lang = escapeHtml(repo.language ?? 'multi')
  const stars = formatStars(repo.stars)
  const pushed = relativeTime(repo.pushedAt)
  const tagColor = REPO_TAG_COLORS[repo.tag]
  const tagLabel = REPO_TAG_LABELS[repo.tag]

  return `
    <div style="margin-bottom:16px;padding-left:12px;border-left:3px solid #6b21a8;">
      <a href="${url}" target="_blank" style="color:#6b21a8;text-decoration:none;font-weight:600;font-size:14px;">${name}</a>
      <span style="display:inline-block;margin-left:8px;padding:2px 6px;background:${tagColor};color:#ffffff;font-size:10px;font-weight:600;border-radius:3px;vertical-align:middle;">${tagLabel}</span>
      <div style="color:#444;font-size:13px;margin-top:4px;line-height:1.5;">${blurb}</div>
      <div style="color:#888;font-size:11px;margin-top:4px;">${stars}&#9733; &middot; ${lang} &middot; pushed ${pushed}</div>
    </div>`
}

function renderRepoItems(repos: ScoredRepo[]): string {
  if (repos.length === 0) {
    return '<p style="color:#888;font-style:italic;margin:0;">No notable GitHub picks for this edition.</p>'
  }
  return repos.map(renderRepoItem).join('\n')
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

// Last section of the email: a copy-paste-ready LinkedIn post. The email only
// goes to the operator, so this gives a one-tap social draft per edition.
function renderLinkedinSection(post: string): string {
  return `
          <tr>
            <td style="padding:10px 32px 6px 32px;">
              <h2 style="margin:0;font-size:18px;font-weight:700;color:#0a66c2;">
                &#x1F4E3; LinkedIn post (copy &amp; paste)
              </h2>
            </td>
          </tr>
          <tr>
            <td style="padding:10px 32px 24px 32px;">
              <pre style="white-space:pre-wrap;word-wrap:break-word;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;background:#f3f6f8;border:1px solid #d0d7de;border-radius:8px;padding:16px;margin:0;">${escapeHtml(post)}</pre>
            </td>
          </tr>`
}

// ---------------------------------------------------------------------------
// Full newsletter renderer
// ---------------------------------------------------------------------------

export interface RenderOptions {
  articles: Record<CategoryId, ScoredArticle[]>
  github: ScoredRepo[]
  executiveInsight: string
  executiveImplication: string
  heroImageSrc: string
  heroArtDirection: string
  lookbackDays: number
  linkedinPost?: string
}

export function renderNewsletter(template: string, opts: RenderOptions): string {
  const cyberHtml = renderCategoryItems(opts.articles.cyber)
  const aiHtml = renderCategoryItems(opts.articles.ai)
  const researchHtml = renderCategoryItems(opts.articles.research)
  const githubHtml = renderRepoItems(opts.github)
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
  html = html.replace(/\{\{GITHUB_ITEMS\}\}/g, githubHtml)
  html = html.replace(/\{\{HERO_IMAGE_SRC\}\}/g, opts.heroImageSrc)
  html = html.replace(/\{\{HERO_ART_DIRECTION\}\}/g, escapeHtml(opts.heroArtDirection))
  html = html.replace(/\{\{LINKEDIN_POST\}\}/g, opts.linkedinPost ? renderLinkedinSection(opts.linkedinPost) : '')

  return html
}
