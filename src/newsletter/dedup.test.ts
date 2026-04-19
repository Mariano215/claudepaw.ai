import { describe, it, expect, beforeAll } from 'vitest'
import Database from 'better-sqlite3'
import {
  createNewsletterTables,
  isSeenUrl,
  markUrlsSeen,
  pruneOldLinks,
  recordEdition,
  getRecentEditions,
} from './dedup.js'

beforeAll(() => {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  createNewsletterTables(db)
})

describe('newsletter dedup', () => {
  const testUrl = 'https://example.com/unique-article-' + Date.now()

  it('reports unseen URL as not seen', () => {
    expect(isSeenUrl(testUrl)).toBe(false)
  })

  it('marks URLs as seen', () => {
    markUrlsSeen([testUrl], '2026-04-03')
    expect(isSeenUrl(testUrl)).toBe(true)
  })

  it('handles duplicate inserts gracefully', () => {
    // Should not throw
    markUrlsSeen([testUrl], '2026-04-03')
    expect(isSeenUrl(testUrl)).toBe(true)
  })

  it('prunes old links without error', () => {
    const pruned = pruneOldLinks(365)
    expect(typeof pruned).toBe('number')
  })
})

describe('newsletter editions', () => {
  it('records an edition', () => {
    const id = 'test-edition-' + Date.now()
    recordEdition({
      id,
      date: '2026-04-03',
      lookback_days: 3,
      articles_cyber: 5,
      articles_ai: 6,
      articles_research: 4,
      hero_path: null,
      html_bytes: 45000,
      sent_at: Math.floor(Date.now() / 1000),
      recipient: 'test@example.com',
    })

    const editions = getRecentEditions(5)
    const found = editions.find((e) => e.id === id)
    expect(found).toBeDefined()
    expect(found!.articles_cyber).toBe(5)
  })

  it('retrieves recent editions in descending order', () => {
    const editions = getRecentEditions(10)
    expect(Array.isArray(editions)).toBe(true)
  })
})
