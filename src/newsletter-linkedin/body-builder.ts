/**
 * Convert The Signal newsletter content into a LinkedIn-ready body
 * (Quill Delta + plain-text preview for the Telegram approval card).
 *
 * Quill Delta rules followed here:
 *   - Inline attributes (bold, italic, link) attach to content ops.
 *   - Block attributes (header, list, blockquote) attach to the closing '\n' op.
 *   - Every block must end with a '\n' insert op.
 *   - Title is set via the LinkedIn Title input separately, not in the body.
 *
 * No browser dependency in this module: it is pure data transformation,
 * unit-testable in isolation.
 */

import type {
  BuildLinkedinBodyInput,
  LinkedinBody,
  QuillDeltaOp,
} from './types.js'
import type { ScoredArticle, ScoredRepo, RepoTag } from '../newsletter/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FAFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1).trimEnd() + '…'
}

function relativeTime(d: Date): string {
  const h = Math.max(0, Math.floor((Date.now() - d.getTime()) / 3_600_000))
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

const REPO_TAG_LABEL: Record<RepoTag, string> = {
  agentic: 'Agentic',
  ai: 'AI',
  cyber: 'Cyber',
}

// ---------------------------------------------------------------------------
// Delta builders
// ---------------------------------------------------------------------------

class DeltaBuilder {
  private ops: QuillDeltaOp[] = []

  text(s: string, attributes?: QuillDeltaOp['attributes']): this {
    if (!s) return this
    this.ops.push(attributes ? { insert: s, attributes } : { insert: s })
    return this
  }

  /** Close current block with an optional block-level attribute. */
  endBlock(attributes?: QuillDeltaOp['attributes']): this {
    this.ops.push(attributes ? { insert: '\n', attributes } : { insert: '\n' })
    return this
  }

  newline(): this {
    return this.endBlock()
  }

  blank(): this {
    return this.endBlock().endBlock()
  }

  header(text: string, level: 2 | 3 = 2): this {
    return this.text(text).endBlock({ header: level })
  }

  bullet(content: () => void): this {
    content()
    return this.endBlock({ list: 'bullet' })
  }

  build(): QuillDeltaOp[] {
    return this.ops
  }
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function appendArticleSection(
  b: DeltaBuilder,
  heading: string,
  articles: ScoredArticle[],
  maxItems = 6,
): void {
  if (articles.length === 0) return
  b.header(heading, 2)
  for (const a of articles.slice(0, maxItems)) {
    const title = clamp(stripHtml(a.title), 200)
    const summary = clamp(stripHtml(a.summary), 240)
    // Quill renders a list item as one block; for prose-y feel we use bullets
    // with the title as a bolded link and summary inline.
    b.bullet(() => {
      b.text(title, { bold: true, link: a.url })
      if (summary) b.text(' — ').text(summary)
    })
  }
  b.newline()
}

function appendRepoSection(b: DeltaBuilder, repos: ScoredRepo[]): void {
  if (repos.length === 0) return
  b.header('GitHub picks worth looking at', 2)
  for (const r of repos) {
    const tagLabel = REPO_TAG_LABEL[r.tag] ?? 'AI'
    const lang = r.language ?? 'multi'
    const stars = formatStars(r.stars)
    const pushed = relativeTime(r.pushedAt)
    const why = clamp(stripHtml(r.whyItMatters || r.description || ''), 260)

    // Three-line repo block: title+tag, why, meta
    b.text(r.fullName, { bold: true, link: r.url })
      .text(` — ${tagLabel}`)
      .endBlock()
    if (why) b.text(why).endBlock()
    b.text(`${stars} stars · ${lang} · pushed ${pushed}`, { italic: true })
      .endBlock()
    b.newline()
  }
}

function appendBriefSection(b: DeltaBuilder, insight: string, implication: string): void {
  b.header('Executive insight', 2)
  b.text(stripHtml(insight)).blank()
  b.text('Recommended action: ', { bold: true })
  b.text(stripHtml(implication)).blank()
}

function appendFooter(
  b: DeltaBuilder,
  subscribeUrl?: string,
  byline?: { name: string; url?: string },
): void {
  if (subscribeUrl) {
    b.text('Subscribe to The Signal for the next edition: ', { italic: true })
      .text(subscribeUrl, { italic: true, link: subscribeUrl })
      .endBlock()
  }
  // Render byline only when a name is provided. URL is optional — when
  // absent the name renders as plain italic text with no link.
  if (byline && byline.name) {
    if (byline.url) {
      // Strip protocol for the display string so we don't show "https://" twice.
      const displayUrl = byline.url.replace(/^https?:\/\//, '')
      b.text(`By ${byline.name} · ${displayUrl}`, { italic: true })
        .text(' · ', { italic: true })
        .text(displayUrl, { italic: true, link: byline.url })
        .endBlock()
    } else {
      b.text(`By ${byline.name}`, { italic: true }).endBlock()
    }
  }
}

// ---------------------------------------------------------------------------
// Plain preview (used by Telegram approval card; LinkedIn never sees this)
// ---------------------------------------------------------------------------

function buildPlainPreview(input: BuildLinkedinBodyInput): string {
  const lines: string[] = []
  const cyber = input.articles.cyber.length
  const ai = input.articles.ai.length
  const research = input.articles.research.length
  const repos = input.github.length
  const briefFirstSentence = stripHtml(input.brief.insight).split(/(?<=\.)\s/)[0] || ''

  lines.push(`Sections: ${cyber} cyber · ${ai} AI · ${research} research · ${repos} repos`)
  if (briefFirstSentence) lines.push(`Insight: ${clamp(briefFirstSentence, 220)}`)
  if (input.github.length > 0) {
    lines.push('Top repos:')
    for (const r of input.github.slice(0, 3)) {
      lines.push(`  - ${r.fullName} (${REPO_TAG_LABEL[r.tag] ?? r.tag})`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function buildLinkedinBody(input: BuildLinkedinBodyInput): LinkedinBody {
  const dateStr = new Date().toISOString().slice(0, 10)
  // Title appears in LinkedIn's Title input; no em dash per repo style.
  const title = `The Signal - ${dateStr}`

  const b = new DeltaBuilder()
  appendBriefSection(b, input.brief.insight, input.brief.implication)
  appendArticleSection(b, 'Cybersecurity this week', input.articles.cyber, 6)
  appendArticleSection(b, 'AI this week', input.articles.ai, 6)
  appendArticleSection(b, 'Research and papers', input.articles.research, 6)
  appendRepoSection(b, input.github)
  appendFooter(b, input.subscribeUrl, input.byline)

  // Quill requires the body to end with a trailing newline.
  const ops = b.build()
  const last = ops[ops.length - 1]
  if (!(last && typeof last.insert === 'string' && last.insert.endsWith('\n'))) {
    ops.push({ insert: '\n' })
  }

  return {
    title,
    delta: ops,
    plainPreview: buildPlainPreview(input),
  }
}

/**
 * Compact markdown serialization used for storage in linkedin_editions.body_md.
 * Decouples persisted data from Quill Delta — the publisher rebuilds the
 * Delta at publish time from this plus the structured input.
 */
export function buildBodyMarkdown(input: BuildLinkedinBodyInput): string {
  const lines: string[] = []
  lines.push('## Executive insight', '', stripHtml(input.brief.insight), '')
  lines.push(`**Recommended action:** ${stripHtml(input.brief.implication)}`, '')

  const renderArticles = (heading: string, arts: ScoredArticle[]) => {
    if (arts.length === 0) return
    lines.push(`## ${heading}`, '')
    for (const a of arts.slice(0, 6)) {
      const title = clamp(stripHtml(a.title), 200)
      const summary = clamp(stripHtml(a.summary), 240)
      lines.push(`- [**${title}**](${a.url}) — ${summary}`)
    }
    lines.push('')
  }
  renderArticles('Cybersecurity this week', input.articles.cyber)
  renderArticles('AI this week', input.articles.ai)
  renderArticles('Research and papers', input.articles.research)

  if (input.github.length > 0) {
    lines.push('## GitHub picks worth looking at', '')
    for (const r of input.github) {
      const tagLabel = REPO_TAG_LABEL[r.tag] ?? 'AI'
      lines.push(`**[${r.fullName}](${r.url})** — ${tagLabel}`)
      lines.push(clamp(stripHtml(r.whyItMatters || r.description || ''), 260))
      lines.push(
        `_${formatStars(r.stars)} stars · ${r.language ?? 'multi'} · pushed ${relativeTime(r.pushedAt)}_`,
      )
      lines.push('')
    }
  }
  if (input.subscribeUrl) {
    lines.push(`_Subscribe: ${input.subscribeUrl}_`)
  }
  if (input.byline && input.byline.name) {
    const displayUrl = input.byline.url
      ? input.byline.url.replace(/^https?:\/\//, '')
      : ''
    lines.push(displayUrl
      ? `_By ${input.byline.name} · ${displayUrl}_`
      : `_By ${input.byline.name}_`)
  }
  return lines.join('\n')
}
