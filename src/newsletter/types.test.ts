import { describe, it, expect } from 'vitest'
import type {
  RawArticle,
  ScoredArticle,
  NewsletterEdition,
  CategoryId,
  TopicId,
} from './types.js'
import {
  FEEDS,
  CYBER_HINTS,
  AI_HINTS,
  RESEARCH_HINTS,
  BLOCK_TERMS,
  PAYWALL_HOSTS,
  TOPIC_MAP,
  NEWSLETTER_CONFIG,
} from './config.js'

describe('newsletter types and config', () => {
  it('exports all feed groups', () => {
    expect(FEEDS.research.length).toBeGreaterThan(0)
    expect(FEEDS.cyber.length).toBeGreaterThan(0)
    expect(FEEDS.ai.length).toBeGreaterThan(0)
    expect(FEEDS.google_news.length).toBe(1)
  })

  it('exports keyword hint arrays', () => {
    expect(CYBER_HINTS.length).toBeGreaterThan(10)
    expect(AI_HINTS.length).toBeGreaterThan(10)
    expect(RESEARCH_HINTS.length).toBeGreaterThan(5)
  })

  it('exports block terms', () => {
    expect(BLOCK_TERMS).toContain('trump')
    expect(BLOCK_TERMS).toContain('nasdaq')
  })

  it('exports paywall hosts', () => {
    expect(PAYWALL_HOSTS).toContain('wsj.com')
    expect(PAYWALL_HOSTS).toContain('nytimes.com')
  })

  it('exports topic map with all topic IDs', () => {
    const ids: TopicId[] = [
      'identity',
      'supply_chain',
      'model_security',
      'data_governance',
      'ai_operations',
      'quantum_readiness',
    ]
    for (const id of ids) {
      expect(TOPIC_MAP[id]).toBeDefined()
      expect(TOPIC_MAP[id].length).toBeGreaterThan(0)
    }
  })

  it('exports newsletter config with required fields', () => {
    expect(NEWSLETTER_CONFIG.recipientEmail).toBeDefined()
    expect(NEWSLETTER_CONFIG.perCategoryLimit).toBe(8)
    expect(NEWSLETTER_CONFIG.probeTimeoutMs).toBe(12000)
    expect(NEWSLETTER_CONFIG.heroDir).toBeTruthy()
    expect(NEWSLETTER_CONFIG.geminiModel).toBeTruthy()
  })

  it('type checks a RawArticle shape', () => {
    const article: RawArticle = {
      title: 'Test Article',
      url: 'https://example.com/article',
      summary: 'A test summary',
      publishedAt: new Date(),
      sourceFeed: 'https://example.com/feed',
      sourceCategory: 'cyber',
    }
    expect(article.title).toBe('Test Article')
  })

  it('type checks a ScoredArticle shape', () => {
    const scored: ScoredArticle = {
      title: 'Test Article',
      url: 'https://example.com/article',
      summary: 'A test summary',
      publishedAt: new Date(),
      sourceFeed: 'https://example.com/feed',
      sourceCategory: 'cyber',
      score: 5.5,
      category: 'cyber',
      sourceDomain: 'example.com',
    }
    expect(scored.score).toBe(5.5)
  })
})
