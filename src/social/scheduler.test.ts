import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  initSocialTables,
  setSocialDb,
  createScheduledPost,
  getPost,
} from './db.js'
import { publishDueSocialPosts } from './scheduler.js'

// Mock the `publish` function from ./index so we do not hit LinkedIn/X
vi.mock('./index.js', async () => {
  const mod = await vi.importActual<typeof import('./index.js')>('./index.js')
  return {
    ...mod,
    publish: vi.fn(),
  }
})

import { publish } from './index.js'
import { markPublished, markFailed } from './db.js'

describe('publishDueSocialPosts', () => {
  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    initSocialTables(db)
    setSocialDb(db)
    vi.mocked(publish).mockReset()
  })

  it('returns zero counts when nothing is due', async () => {
    const send = vi.fn(async (_chatId: string, _text: string) => {})
    const result = await publishDueSocialPosts(send, '123456789')
    expect(result).toEqual({ attempted: 0, published: 0, failed: 0 })
    expect(publish).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('publishes a due post and does not notify on success', async () => {
    const p = createScheduledPost({
      platform: 'linkedin',
      content: 'hi',
      project_id: 'default',
      scheduled_at: Date.now() - 1000,
      created_by: 'producer',
    })
    vi.mocked(publish).mockImplementation(async (id: string) => {
      markPublished(id, 'urn:li:share:1', 'https://li/1')
      return true
    })

    const send = vi.fn(async () => {})
    const result = await publishDueSocialPosts(send, '123456789')

    expect(result).toEqual({ attempted: 1, published: 1, failed: 0 })
    expect(publish).toHaveBeenCalledWith(p.id)
    expect(send).not.toHaveBeenCalled()
    expect(getPost(p.id)!.status).toBe('published')
  })

  it('notifies on failure', async () => {
    const p = createScheduledPost({
      platform: 'twitter',
      content: 'will fail',
      project_id: 'default',
      scheduled_at: Date.now() - 1000,
      created_by: 'producer',
    })
    vi.mocked(publish).mockImplementation(async (id: string) => {
      markFailed(id, 'rate limited')
      return false
    })

    const send = vi.fn(async (_chatId: string, _text: string) => {})
    const result = await publishDueSocialPosts(send, '123456789')

    expect(result).toEqual({ attempted: 1, published: 0, failed: 1 })
    expect(send).toHaveBeenCalledTimes(1)
    const [chatId, text] = send.mock.calls[0]!
    expect(chatId).toBe('123456789')
    expect(text).toContain('FAILED')
    expect(text).toContain('X (Twitter)')
    expect(text).toContain('rate limited')
    expect(getPost(p.id)!.status).toBe('failed')
  })

  it('marks failed and notifies when publish throws', async () => {
    const p = createScheduledPost({
      platform: 'linkedin',
      content: 'will throw',
      project_id: 'default',
      scheduled_at: Date.now() - 1000,
      created_by: 'producer',
    })
    vi.mocked(publish).mockImplementation(async () => {
      throw new Error('boom')
    })

    const send = vi.fn(async (_chatId: string, _text: string) => {})
    const result = await publishDueSocialPosts(send, '123456789')

    expect(result).toEqual({ attempted: 1, published: 0, failed: 1 })
    expect(getPost(p.id)!.status).toBe('failed')
    expect(getPost(p.id)!.error).toContain('boom')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![1]).toContain('boom')
  })

  it('skips posts whose status is not approved', async () => {
    // A scheduled post gets rejected before its scheduled_at fires.
    // It must NOT be published on the tick.
    const p = createScheduledPost({
      platform: 'linkedin',
      content: 'to reject',
      project_id: 'default',
      scheduled_at: Date.now() - 1000,
      created_by: 'producer',
    })
    const { rejectPost } = await import('./db.js')
    rejectPost(p.id)

    const send = vi.fn(async () => {})
    const result = await publishDueSocialPosts(send, '123456789')
    expect(result).toEqual({ attempted: 0, published: 0, failed: 0 })
    expect(publish).not.toHaveBeenCalled()
  })

  it('reports a corruption error instead of Unknown error when a due row is missing its id', async () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.exec(`CREATE TABLE social_posts (
      id               TEXT PRIMARY KEY,
      platform         TEXT NOT NULL,
      content          TEXT NOT NULL,
      media_url        TEXT,
      suggested_time   TEXT,
      cta              TEXT,
      status           TEXT NOT NULL,
      platform_post_id TEXT,
      platform_url     TEXT,
      error            TEXT,
      created_at       INTEGER NOT NULL,
      published_at     INTEGER,
      scheduled_at     INTEGER,
      created_by       TEXT NOT NULL,
      project_id       TEXT NOT NULL
    )`)
    db.prepare(
      `INSERT INTO social_posts
         (id, platform, content, status, created_at, scheduled_at, created_by, project_id)
       VALUES (?, ?, ?, 'approved', ?, ?, 'legacy', ?)`,
    ).run(null, 'facebook', 'broken row', Date.now() - 5_000, Date.now() - 1_000, 'example-company')
    setSocialDb(db)

    const send = vi.fn(async () => {})
    const result = await publishDueSocialPosts(send, '123456789')

    expect(result).toEqual({ attempted: 1, published: 0, failed: 1 })
    expect(publish).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    const firstCall = send.mock.calls[0] as unknown as [string, string] | undefined
    expect(firstCall).toBeDefined()
    const text = firstCall![1]
    expect(text).toContain('Corrupt social post row: missing id')
    expect(text).toContain('Post ID: null')
  })
})
