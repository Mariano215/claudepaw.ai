import { describe, it, expect } from 'vitest'
import { renderArticleItem, renderNewsletter } from './renderer.js'
import type { ScoredArticle, CategoryId } from './types.js'

function makeArticle(overrides: Partial<ScoredArticle> = {}): ScoredArticle {
  return {
    title: 'Test Zero-Day Discovery',
    url: 'https://example.com/article',
    summary: 'A critical zero-day was found in widely used software.',
    publishedAt: new Date('2026-04-03T12:00:00Z'),
    sourceFeed: 'https://example.com/feed',
    sourceCategory: 'cyber',
    score: 8,
    category: 'cyber',
    sourceDomain: 'example.com',
    ...overrides,
  }
}

describe('renderArticleItem', () => {
  it('renders an article as HTML with link and domain', () => {
    const html = renderArticleItem(makeArticle())
    expect(html).toContain('href="https://example.com/article"')
    expect(html).toContain('Test Zero-Day Discovery')
    expect(html).toContain('example.com')
    expect(html).toContain('A critical zero-day')
  })

  it('escapes HTML in title and summary', () => {
    const html = renderArticleItem(
      makeArticle({
        title: 'XSS <script>alert("bad")</script>',
        summary: 'Content with <b>tags</b>',
      }),
    )
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>tags</b>')
  })
})

describe('renderNewsletter', () => {
  it('replaces all template placeholders', () => {
    const articles: Record<CategoryId, ScoredArticle[]> = {
      cyber: [makeArticle()],
      ai: [makeArticle({ category: 'ai', title: 'AI Article' })],
      research: [makeArticle({ category: 'research', title: 'Research Paper' })],
    }

    const template = `
      {{REPORT_WINDOW}} {{LOOKBACK_DAYS}} {{RUN_WEEKDAY}}
      {{EXECUTIVE_INSIGHT}} {{EXECUTIVE_IMPLICATION}}
      {{CYBER_ITEMS}} {{AI_ITEMS}} {{RESEARCH_ITEMS}}
      {{HERO_IMAGE_SRC}} {{HERO_ART_DIRECTION}}
    `

    const html = renderNewsletter(template, {
      articles,
      executiveInsight: 'Insight text here',
      executiveImplication: 'Implication text here',
      heroImageSrc: 'data:image/jpeg;base64,abc',
      heroArtDirection: 'cyberpunk scene',
      lookbackDays: 3,
    })

    expect(html).not.toContain('{{REPORT_WINDOW}}')
    expect(html).not.toContain('{{LOOKBACK_DAYS}}')
    expect(html).not.toContain('{{EXECUTIVE_INSIGHT}}')
    expect(html).not.toContain('{{CYBER_ITEMS}}')
    expect(html).toContain('Insight text here')
    expect(html).toContain('Implication text here')
    expect(html).toContain('Test Zero-Day Discovery')
    expect(html).toContain('data:image/jpeg;base64,abc')
  })
})
