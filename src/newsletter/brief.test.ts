import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { analyzeTopics, generateExecutiveBrief } from './brief.js'
import type { ScoredArticle, CategoryId } from './types.js'

function makeScored(overrides: Partial<ScoredArticle> = {}): ScoredArticle {
  return {
    title: 'Test zero trust identity article',
    url: 'https://example.com/1',
    summary: 'New zero trust identity framework improves authentication security.',
    publishedAt: new Date(),
    sourceFeed: 'https://example.com/feed',
    sourceCategory: 'cyber',
    score: 5,
    category: 'cyber',
    sourceDomain: 'example.com',
    ...overrides,
  }
}

describe('analyzeTopics', () => {
  it('identifies dominant topics from articles', () => {
    const articles: Record<CategoryId, ScoredArticle[]> = {
      cyber: [
        makeScored({
          title: 'Zero trust identity breach',
          summary: 'Authentication failure leads to credential theft',
        }),
        makeScored({
          title: 'Supply chain attack on npm',
          summary: 'Dependency confusion exploit targets npm packages',
        }),
      ],
      ai: [
        makeScored({
          title: 'LLM prompt injection jailbreak',
          summary: 'Model security concerns rise',
          category: 'ai',
        }),
      ],
      research: [],
    }

    const topics = analyzeTopics(articles)
    expect(topics.length).toBeLessThanOrEqual(3)
    expect(topics.length).toBeGreaterThan(0)
    expect(topics).toContain('identity')
  })

  it('returns up to 3 topics', () => {
    const articles: Record<CategoryId, ScoredArticle[]> = {
      cyber: Array.from({ length: 10 }, (_, i) =>
        makeScored({
          title: `Article ${i} about identity authentication mfa sso zero trust`,
          summary: `Details about quantum computing pqc and supply chain sbom attacks on model security adversarial prompt injection`,
        }),
      ),
      ai: [],
      research: [],
    }

    const topics = analyzeTopics(articles)
    expect(topics.length).toBeLessThanOrEqual(3)
  })
})

describe('generateExecutiveBrief', () => {
  const originalFetch = global.fetch
  const originalKey = process.env.ANTHROPIC_API_KEY

  beforeEach(() => {
    // Tests mock `fetch`, so give the LLM path a key to get past the
    // early-return check inside callAnthropicForBrief. CI runners don't
    // have a real key; local dev might, so we force a predictable value.
    process.env.ANTHROPIC_API_KEY = 'test-key-for-mock'
    // Default: force LLM path to fail so the heuristic fallback runs
    // deterministically. Individual tests may override this mock.
    global.fetch = vi.fn(async () =>
      new Response('unavailable', { status: 503 }),
    ) as unknown as typeof fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey
    }
  })

  it('produces insight and implication strings (heuristic fallback path)', async () => {
    const articles: Record<CategoryId, ScoredArticle[]> = {
      cyber: [makeScored()],
      ai: [makeScored({ category: 'ai' })],
      research: [],
    }

    const brief = await generateExecutiveBrief(articles)
    expect(brief.insight).toBeTruthy()
    expect(brief.implication).toBeTruthy()
    expect(brief.topThemes.length).toBeGreaterThan(0)
  })

  it('uses LLM output when the API returns valid JSON', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text:
                '{"insight":"Deep insight about the threat landscape.","implication":"Specific action for the CISO."}',
            },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch

    const articles: Record<CategoryId, ScoredArticle[]> = {
      cyber: [makeScored()],
      ai: [],
      research: [],
    }

    const brief = await generateExecutiveBrief(articles)
    expect(brief.insight).toBe('Deep insight about the threat landscape.')
    expect(brief.implication).toBe('Specific action for the CISO.')
  })
})
