import { describe, it, expect } from 'vitest'
import { parseRssXml, normalizeUrl, resolveGoogleNewsUrl } from './feeds.js'

describe('parseRssXml', () => {
  it('parses standard RSS 2.0 feed', () => {
    const xml = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <title>Test Feed</title>
        <item>
          <title>Article One</title>
          <link>https://example.com/one</link>
          <description>Summary of article one</description>
          <pubDate>Thu, 03 Apr 2026 12:00:00 GMT</pubDate>
        </item>
        <item>
          <title>Article Two</title>
          <link>https://example.com/two</link>
          <description><![CDATA[<p>Summary with HTML</p>]]></description>
          <pubDate>Wed, 02 Apr 2026 10:00:00 GMT</pubDate>
        </item>
      </channel>
    </rss>`

    const articles = parseRssXml(xml, 'https://example.com/feed', 'cyber')
    expect(articles).toHaveLength(2)
    expect(articles[0].title).toBe('Article One')
    expect(articles[0].url).toBe('https://example.com/one')
    expect(articles[0].summary).toBe('Summary of article one')
    expect(articles[0].sourceFeed).toBe('https://example.com/feed')
    expect(articles[0].sourceCategory).toBe('cyber')
    expect(articles[0].publishedAt).toBeInstanceOf(Date)
  })

  it('parses Atom feed', () => {
    const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom Feed</title>
      <entry>
        <title>Atom Article</title>
        <link href="https://example.com/atom-one"/>
        <summary>Atom summary</summary>
        <updated>2026-04-03T12:00:00Z</updated>
      </entry>
    </feed>`

    const articles = parseRssXml(xml, 'https://example.com/atom', 'ai')
    expect(articles).toHaveLength(1)
    expect(articles[0].title).toBe('Atom Article')
    expect(articles[0].url).toBe('https://example.com/atom-one')
    expect(articles[0].sourceCategory).toBe('ai')
  })

  it('strips HTML tags from descriptions', () => {
    const xml = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <item>
          <title>Test</title>
          <link>https://example.com/test</link>
          <description><![CDATA[<p>Bold <b>text</b> and <a href="#">links</a></p>]]></description>
          <pubDate>Thu, 03 Apr 2026 12:00:00 GMT</pubDate>
        </item>
      </channel>
    </rss>`

    const articles = parseRssXml(xml, 'https://example.com/feed', 'cyber')
    expect(articles[0].summary).not.toContain('<')
    expect(articles[0].summary).toContain('Bold text and links')
  })

  it('handles arxiv RDF feed format', () => {
    const xml = `<?xml version="1.0"?>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
             xmlns="http://purl.org/rss/1.0/"
             xmlns:dc="http://purl.org/dc/elements/1.1/">
      <item rdf:about="http://arxiv.org/abs/2604.01234">
        <title>arXiv Paper Title. (arXiv:2604.01234v1 [cs.CR])</title>
        <link>http://arxiv.org/abs/2604.01234</link>
        <description>This paper explores new methods...</description>
        <dc:date>2026-04-03</dc:date>
      </item>
    </rdf:RDF>`

    const articles = parseRssXml(xml, 'http://export.arxiv.org/rss/cs.CR', 'research')
    expect(articles).toHaveLength(1)
    expect(articles[0].title).toContain('arXiv Paper Title')
    expect(articles[0].url).toBe('http://arxiv.org/abs/2604.01234')
  })
})

describe('normalizeUrl', () => {
  it('strips UTM parameters', () => {
    const url = 'https://example.com/article?utm_source=rss&utm_medium=feed&id=123'
    const normalized = normalizeUrl(url)
    expect(normalized).toBe('https://example.com/article?id=123')
  })

  it('strips all UTM variants', () => {
    const url = 'https://example.com/page?utm_campaign=test&utm_content=a&utm_term=b'
    const normalized = normalizeUrl(url)
    expect(normalized).toBe('https://example.com/page')
  })

  it('removes trailing question mark when all params stripped', () => {
    const url = 'https://example.com/page?utm_source=rss'
    const normalized = normalizeUrl(url)
    expect(normalized).toBe('https://example.com/page')
  })

  it('removes trailing slash', () => {
    const url = 'https://example.com/page/'
    const normalized = normalizeUrl(url)
    expect(normalized).toBe('https://example.com/page')
  })

  it('handles URLs without query params', () => {
    const url = 'https://example.com/article'
    expect(normalizeUrl(url)).toBe('https://example.com/article')
  })
})

describe('resolveGoogleNewsUrl', () => {
  it('returns original URL for non-Google-News URLs', () => {
    const url = 'https://example.com/article'
    expect(resolveGoogleNewsUrl(url)).toBe(url)
  })

  it('identifies Google News redirect URLs', () => {
    const url = 'https://news.google.com/rss/articles/CBMi...'
    // This test verifies the function at least does not throw
    const result = resolveGoogleNewsUrl(url)
    expect(typeof result).toBe('string')
  })
})
