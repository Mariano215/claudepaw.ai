import { describe, it, expect } from 'vitest'
import {
  scoreArticle,
  isBlocked,
  categorizeGoogleNewsArticle,
  selectTopArticles,
} from './scorer.js'
import type { RawArticle, ScoredArticle } from './types.js'

function makeArticle(overrides: Partial<RawArticle> = {}): RawArticle {
  return {
    title: 'Test Article About Cybersecurity',
    url: 'https://example.com/article',
    summary: 'A new zero-day vulnerability was discovered in the wild.',
    publishedAt: new Date(),
    sourceFeed: 'https://example.com/feed',
    sourceCategory: 'cyber',
    ...overrides,
  }
}

describe('isBlocked', () => {
  it('blocks articles with block terms in title', () => {
    expect(isBlocked(makeArticle({ title: 'Trump announces new cyber policy' }))).toBe(true)
  })

  it('blocks articles with block terms in summary', () => {
    expect(isBlocked(makeArticle({ summary: 'Nasdaq plunges due to cyber fears' }))).toBe(true)
  })

  it('passes clean articles', () => {
    expect(isBlocked(makeArticle())).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isBlocked(makeArticle({ title: 'NASDAQ drops 5%' }))).toBe(true)
  })
})

describe('scoreArticle', () => {
  it('scores higher for keyword matches', () => {
    const a = makeArticle({ summary: 'A simple update to the system.' })
    const b = makeArticle({
      summary: 'A new zero-day exploit discovered targeting supply chain.',
    })
    expect(scoreArticle(b, 'cyber')).toBeGreaterThan(scoreArticle(a, 'cyber'))
  })

  it('gives multi-word hint matches +2', () => {
    // 'zero day' is a multi-word hint
    const article = makeArticle({ title: 'zero day', summary: '' })
    const score = scoreArticle(article, 'cyber')
    // Should include at least 2 for the multi-word match
    expect(score).toBeGreaterThanOrEqual(2)
  })

  it('adds recency bonus for newer articles', () => {
    const recent = makeArticle({ publishedAt: new Date() })
    const old = makeArticle({
      publishedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    })
    expect(scoreArticle(recent, 'cyber')).toBeGreaterThan(scoreArticle(old, 'cyber'))
  })
})

describe('categorizeGoogleNewsArticle', () => {
  it('assigns cyber category for cyber keywords', () => {
    const article = makeArticle({
      title: 'New ransomware attack hits hospitals',
      sourceCategory: 'google_news',
    })
    expect(categorizeGoogleNewsArticle(article)).toBe('cyber')
  })

  it('assigns ai category for AI keywords', () => {
    const article = makeArticle({
      title: 'OpenAI releases new large language model',
      summary: 'The generative ai transformer achieves breakthrough in natural language processing benchmarks.',
      sourceCategory: 'google_news',
    })
    expect(categorizeGoogleNewsArticle(article)).toBe('ai')
  })

  it('defaults to research when ambiguous', () => {
    const article = makeArticle({
      title: 'New scientific discovery',
      summary: 'Interesting research findings',
      sourceCategory: 'google_news',
    })
    expect(categorizeGoogleNewsArticle(article)).toBe('research')
  })
})

describe('selectTopArticles', () => {
  it('respects per-category limit', () => {
    const articles: ScoredArticle[] = Array.from({ length: 20 }, (_, i) => ({
      title: `Article ${i}`,
      url: `https://example.com/${i}`,
      summary: 'Summary',
      publishedAt: new Date(),
      sourceFeed: 'https://example.com/feed',
      sourceCategory: 'cyber' as const,
      score: 20 - i,
      category: 'cyber' as const,
      sourceDomain: 'example.com',
    }))

    const result = selectTopArticles(articles, 8)
    expect(result.cyber.length).toBeLessThanOrEqual(8)
  })

  it('sorts by score descending', () => {
    const articles: ScoredArticle[] = [
      {
        title: 'Low', url: 'https://a.com/1', summary: '', publishedAt: new Date(),
        sourceFeed: '', sourceCategory: 'cyber', score: 1, category: 'cyber',
        sourceDomain: 'a.com',
      },
      {
        title: 'High', url: 'https://a.com/2', summary: '', publishedAt: new Date(),
        sourceFeed: '', sourceCategory: 'cyber', score: 10, category: 'cyber',
        sourceDomain: 'a.com',
      },
    ]

    const result = selectTopArticles(articles, 8)
    expect(result.cyber[0].title).toBe('High')
  })
})
