import { describe, it, expect } from 'vitest'
import { buildLinkedinBody, buildBodyMarkdown } from './body-builder.js'
import type {
  ScoredArticle,
  ScoredRepo,
  ExecutiveBrief,
  CategoryId,
} from '../newsletter/types.js'
import type { BuildLinkedinBodyInput, LinkedinBody, QuillDeltaOp } from './types.js'

function makeArticle(overrides: Partial<ScoredArticle> = {}): ScoredArticle {
  return {
    title: 'Sample article title',
    url: 'https://example.com/article',
    summary: 'Short summary describing the article content.',
    publishedAt: new Date('2026-05-17T10:00:00Z'),
    sourceFeed: 'https://example.com/feed.xml',
    sourceCategory: 'cyber',
    score: 10,
    category: 'cyber',
    sourceDomain: 'example.com',
    ...overrides,
  }
}

function makeRepo(overrides: Partial<ScoredRepo> = {}): ScoredRepo {
  return {
    fullName: 'octocat/example',
    url: 'https://github.com/octocat/example',
    description: 'Example repo description',
    stars: 1200,
    language: 'TypeScript',
    pushedAt: new Date(Date.now() - 2 * 86_400_000),
    createdAt: new Date('2025-12-01'),
    topics: ['llm', 'rag'],
    latestReleaseTag: null,
    latestReleaseAt: null,
    bucket: 'rising',
    matchedQuery: 'topic:ai-agents',
    tag: 'agentic',
    score: 5000,
    whyItMatters: 'Solves a real problem for agentic AI builders.',
    ...overrides,
  }
}

function makeBrief(overrides: Partial<ExecutiveBrief> = {}): ExecutiveBrief {
  return {
    insight: 'This week the dominant theme is identity-first security.',
    implication: 'Audit MFA enforcement across all admin consoles by Friday.',
    topThemes: ['identity', 'ai_operations'],
    ...overrides,
  }
}

function makeInput(overrides: Partial<BuildLinkedinBodyInput> = {}): BuildLinkedinBodyInput {
  const articles: Record<CategoryId, ScoredArticle[]> = {
    cyber: [makeArticle({ title: 'Cyber A', url: 'https://c.example/a' })],
    ai: [makeArticle({ category: 'ai', title: 'AI A', url: 'https://a.example/a' })],
    research: [makeArticle({ category: 'research', title: 'Paper A', url: 'https://r.example/a' })],
  }
  return {
    brief: makeBrief(),
    articles,
    github: [makeRepo()],
    ...overrides,
  }
}

describe('buildLinkedinBody', () => {
  it('produces a valid Quill Delta structure', () => {
    const body = buildLinkedinBody(makeInput())
    expect(body.delta).toBeInstanceOf(Array)
    expect(body.delta.length).toBeGreaterThan(0)
    for (const op of body.delta) {
      expect(op).toHaveProperty('insert')
    }
  })

  it('ends the body with a trailing newline op', () => {
    const body = buildLinkedinBody(makeInput())
    const last = body.delta[body.delta.length - 1]
    expect(typeof last.insert).toBe('string')
    expect((last.insert as string).endsWith('\n')).toBe(true)
  })

  it('uses block-level header attribute on \\n ops only, not on content ops', () => {
    const body = buildLinkedinBody(makeInput())
    for (const op of body.delta) {
      if (op.attributes?.header) {
        // Header attributes must be on a '\n' insert op (Quill block rule)
        expect(op.insert).toBe('\n')
      }
    }
  })

  it('attaches inline attributes (bold, italic, link) only to non-newline ops', () => {
    const body = buildLinkedinBody(makeInput())
    for (const op of body.delta) {
      const hasInline =
        op.attributes &&
        (op.attributes.bold || op.attributes.italic || op.attributes.link)
      if (hasInline && typeof op.insert === 'string') {
        expect(op.insert).not.toBe('\n')
      }
    }
  })

  it('emits H2 headers for each populated section', () => {
    const body = buildLinkedinBody(makeInput())
    const headers = body.delta.filter((op) => op.attributes?.header === 2)
    // Executive insight, Cybersecurity, AI, Research, GitHub
    expect(headers.length).toBe(5)
  })

  it('omits article sections that are empty', () => {
    const input = makeInput({
      articles: {
        cyber: [],
        ai: [makeArticle({ category: 'ai' })],
        research: [],
      },
    })
    const body = buildLinkedinBody(input)
    const text = body.delta.map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('')
    expect(text).not.toContain('Cybersecurity this week')
    expect(text).not.toContain('Research and papers')
    expect(text).toContain('AI this week')
  })

  it('renders article titles as bold links', () => {
    const input = makeInput({
      articles: {
        cyber: [makeArticle({ title: 'Unique Cyber Story', url: 'https://uniq.example/1' })],
        ai: [],
        research: [],
      },
    })
    const body = buildLinkedinBody(input)
    const titleOp = body.delta.find(
      (op) => typeof op.insert === 'string' && op.insert === 'Unique Cyber Story',
    )
    expect(titleOp).toBeDefined()
    expect(titleOp?.attributes?.bold).toBe(true)
    expect(titleOp?.attributes?.link).toBe('https://uniq.example/1')
  })

  it('renders repo owner/repo as bold link with tag suffix', () => {
    const body = buildLinkedinBody(
      makeInput({
        github: [
          makeRepo({
            fullName: 'foo/bar',
            url: 'https://github.com/foo/bar',
            tag: 'cyber',
          }),
        ],
      }),
    )
    const nameOp = body.delta.find(
      (op) => typeof op.insert === 'string' && op.insert === 'foo/bar',
    )
    expect(nameOp?.attributes?.bold).toBe(true)
    expect(nameOp?.attributes?.link).toContain('foo/bar')

    const text = body.delta.map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('')
    expect(text).toContain('Cyber') // tag label
    expect(text).toMatch(/[\d.]+k? stars/)
  })

  it('strips HTML from article summaries and titles', () => {
    const body = buildLinkedinBody(
      makeInput({
        articles: {
          cyber: [
            makeArticle({
              title: '<b>Bold Title</b>',
              summary: 'Summary with <a href="x">link</a> &amp; entities.',
            }),
          ],
          ai: [],
          research: [],
        },
      }),
    )
    const text = body.delta.map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('')
    expect(text).toContain('Bold Title')
    expect(text).not.toContain('<b>')
    expect(text).not.toContain('</a>')
    expect(text).toContain('Summary with link & entities.')
  })

  it('builds a non-empty plain preview', () => {
    const body = buildLinkedinBody(makeInput())
    expect(body.plainPreview.length).toBeGreaterThan(0)
    expect(body.plainPreview).toContain('Sections:')
  })

  it('includes subscribe URL footer when provided', () => {
    const url = 'https://www.linkedin.com/newsletters/the-signal-123'
    const body = buildLinkedinBody(makeInput({ subscribeUrl: url }))
    const text = body.delta.map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('')
    expect(text).toContain('Subscribe to The Signal')
    const linkOp = body.delta.find(
      (op) => op.attributes?.link === url,
    )
    expect(linkOp).toBeDefined()
  })

  it('produces title in YYYY-MM-DD form with ASCII hyphen (no em dash)', () => {
    const body = buildLinkedinBody(makeInput())
    expect(body.title).toMatch(/^The Signal - \d{4}-\d{2}-\d{2}$/)
    expect(body.title).not.toContain('—')
  })

  // Locate the italic byline op in the Delta output. Returns the insert
  // text (or null) so each test can assert content. Italic + leading "By "
  // is the unique signature -- article body text isn't italicized.
  const findBylineOp = (body: LinkedinBody): string | null => {
    const op = body.delta.find(
      (o) => o.attributes?.italic && typeof o.insert === 'string' && o.insert.startsWith('By '),
    )
    return op && typeof op.insert === 'string' ? op.insert : null
  }

  it('omits byline when no byline provided (no hardcoded names)', () => {
    const body = buildLinkedinBody(makeInput())
    expect(findBylineOp(body)).toBeNull()
  })

  it('renders byline with name + url when both provided', () => {
    const body = buildLinkedinBody(makeInput({
      byline: { name: 'Jane Doe', url: 'https://example.com' },
    }))
    expect(findBylineOp(body)).toBe('By Jane Doe · example.com')
    const linkOp = body.delta.find((op) => op.attributes?.link === 'https://example.com')
    expect(linkOp).toBeDefined()
  })

  it('renders byline with name only when url omitted', () => {
    const body = buildLinkedinBody(makeInput({
      byline: { name: 'Jane Doe' },
    }))
    expect(findBylineOp(body)).toBe('By Jane Doe')
  })

  it('omits byline when name is empty string', () => {
    const body = buildLinkedinBody(makeInput({
      byline: { name: '', url: 'https://example.com' },
    }))
    expect(findBylineOp(body)).toBeNull()
  })
})

describe('buildBodyMarkdown', () => {
  it('returns parseable markdown with sections', () => {
    const md = buildBodyMarkdown(makeInput())
    expect(md).toContain('## Executive insight')
    expect(md).toContain('**Recommended action:**')
    expect(md).toContain('## Cybersecurity this week')
    expect(md).toContain('## GitHub picks worth looking at')
  })

  it('omits a section when input array is empty', () => {
    const input = makeInput({
      articles: { cyber: [], ai: [], research: [] },
      github: [],
    })
    const md = buildBodyMarkdown(input)
    expect(md).toContain('## Executive insight')
    expect(md).not.toContain('## Cybersecurity this week')
    expect(md).not.toContain('## GitHub picks')
  })
})
