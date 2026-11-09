import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  initSocialTables,
  setSocialDb,
  createDraft,
  getPost,
  listDrafts,
  listPosts,
  approvePost,
  rejectPost,
  markPublished,
  markFailed,
  updateContent,
  getPostStats,
  createScheduledPost,
  listDueApproved,
  hasCrossPostForVideo,
} from './db.js'

describe('social/db', () => {
  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    initSocialTables(db)
    setSocialDb(db)
  })

  it('creates a draft and retrieves it', () => {
    const post = createDraft({ platform: 'twitter', content: 'Hello X!', project_id: 'default' })
    expect(post.id).toBeTruthy()
    expect(post.platform).toBe('twitter')
    expect(post.content).toBe('Hello X!')
    expect(post.status).toBe('draft')

    const fetched = getPost(post.id)
    expect(fetched).toBeDefined()
    expect(fetched!.content).toBe('Hello X!')
  })

  it('lists drafts', () => {
    createDraft({ platform: 'twitter', content: 'Tweet 1', project_id: 'default' })
    createDraft({ platform: 'linkedin', content: 'LinkedIn post', project_id: 'default' })
    const drafts = listDrafts()
    expect(drafts).toHaveLength(2)
  })

  it('approves a draft', () => {
    const post = createDraft({ platform: 'twitter', content: 'Approve me', project_id: 'default' })
    const ok = approvePost(post.id)
    expect(ok).toBe(true)
    expect(getPost(post.id)!.status).toBe('approved')
  })

  it('rejects a draft', () => {
    const post = createDraft({ platform: 'linkedin', content: 'Reject me', project_id: 'default' })
    const ok = rejectPost(post.id)
    expect(ok).toBe(true)
    expect(getPost(post.id)!.status).toBe('rejected')
  })

  it('marks a post as published', () => {
    const post = createDraft({ platform: 'twitter', content: 'Publish me', project_id: 'default' })
    approvePost(post.id)
    markPublished(post.id, 'tweet-123', 'https://x.com/status/123')
    const updated = getPost(post.id)!
    expect(updated.status).toBe('published')
    expect(updated.platform_post_id).toBe('tweet-123')
    expect(updated.platform_url).toBe('https://x.com/status/123')
    expect(updated.published_at).toBeTruthy()
  })

  it('marks a post as failed', () => {
    const post = createDraft({ platform: 'twitter', content: 'Fail me', project_id: 'default' })
    approvePost(post.id)
    markFailed(post.id, 'Rate limited')
    const updated = getPost(post.id)!
    expect(updated.status).toBe('failed')
    expect(updated.error).toBe('Rate limited')
  })

  it('updates draft content', () => {
    const post = createDraft({ platform: 'twitter', content: 'Original', project_id: 'default' })
    updateContent(post.id, 'Updated content')
    expect(getPost(post.id)!.content).toBe('Updated content')
  })

  it('does not update published post content', () => {
    const post = createDraft({ platform: 'twitter', content: 'Original', project_id: 'default' })
    approvePost(post.id)
    markPublished(post.id, 'id', 'url')
    const ok = updateContent(post.id, 'Should not change')
    expect(ok).toBe(false)
    expect(getPost(post.id)!.content).toBe('Original')
  })

  it('returns post stats', () => {
    createDraft({ platform: 'twitter', content: 'Draft 1', project_id: 'default' })
    createDraft({ platform: 'twitter', content: 'Draft 2', project_id: 'default' })
    const p = createDraft({ platform: 'linkedin', content: 'To publish', project_id: 'default' })
    approvePost(p.id)
    markPublished(p.id, 'id', 'url')
    const r = createDraft({ platform: 'twitter', content: 'To reject', project_id: 'default' })
    rejectPost(r.id)

    const stats = getPostStats()
    expect(stats.drafts).toBe(2)
    expect(stats.published).toBe(1)
    expect(stats.rejected).toBe(1)
    expect(stats.failed).toBe(0)
  })

  it('lists posts by status', () => {
    createDraft({ platform: 'twitter', content: 'Draft', project_id: 'default' })
    const p = createDraft({ platform: 'twitter', content: 'Published', project_id: 'default' })
    approvePost(p.id)
    markPublished(p.id, 'id', 'url')

    expect(listPosts('draft')).toHaveLength(1)
    expect(listPosts('published')).toHaveLength(1)
    expect(listPosts()).toHaveLength(2)
  })

  it('adds scheduled_at column after init', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    initSocialTables(db)
    const cols = db
      .prepare("PRAGMA table_info(social_posts)")
      .all() as Array<{ name: string; type: string; notnull: number }>
    const scheduled = cols.find((c) => c.name === 'scheduled_at')
    const id = cols.find((c) => c.name === 'id')
    expect(scheduled).toBeDefined()
    expect(scheduled!.type.toUpperCase()).toBe('INTEGER')
    expect(id).toBeDefined()
    expect(id!.notnull).toBe(1)
  })

  it('creates idx_social_due partial index', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    initSocialTables(db)
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_social_due'")
      .get() as { name: string } | undefined
    expect(idx).toBeDefined()
    expect(idx!.name).toBe('idx_social_due')
  })

  it('stores optional fields', () => {
    const post = createDraft({
      platform: 'linkedin',
      content: 'Check this out',
      media_url: 'https://youtube.com/watch?v=abc',
      suggested_time: 'morning EST',
      cta: 'Subscribe to the channel',
      created_by: 'social',
      project_id: 'default',
    })
    const fetched = getPost(post.id)!
    expect(fetched.media_url).toBe('https://youtube.com/watch?v=abc')
    expect(fetched.suggested_time).toBe('morning EST')
    expect(fetched.cta).toBe('Subscribe to the channel')
    expect(fetched.created_by).toBe('social')
  })

  it('createScheduledPost inserts as approved with scheduled_at', () => {
    const future = Date.now() + 60_000
    const post = createScheduledPost({
      platform: 'linkedin',
      content: 'Hello scheduled',
      project_id: 'default',
      scheduled_at: future,
      created_by: 'producer',
    })
    expect(post.status).toBe('approved')
    expect(post.scheduled_at).toBe(future)
    expect(post.platform).toBe('linkedin')
  })

  it('listDueApproved returns only past-due approved posts', () => {
    const now = Date.now()
    createScheduledPost({
      platform: 'linkedin', content: 'past', project_id: 'default',
      scheduled_at: now - 1000, created_by: 'producer',
    })
    createScheduledPost({
      platform: 'twitter', content: 'future', project_id: 'default',
      scheduled_at: now + 60_000, created_by: 'producer',
    })
    // a non-scheduled draft should NOT appear
    createDraft({ platform: 'twitter', content: 'legacy draft', project_id: 'default' })

    const due = listDueApproved(now)
    expect(due).toHaveLength(1)
    expect(due[0].content).toBe('past')
    expect(due[0].status).toBe('approved')
  })

  it('hasCrossPostForVideo detects an already-published youtu.be link', () => {
    const p = createDraft({
      platform: 'linkedin',
      content: 'Watch the new one: https://youtu.be/abc12345678',
      project_id: 'default',
    })
    approvePost(p.id)
    markPublished(p.id, 'urn:li:share:1', 'https://linkedin.com/...')

    expect(hasCrossPostForVideo('default', 'abc12345678')).toBe(true)
    expect(hasCrossPostForVideo('default', 'nonexistent1')).toBe(false)
  })

  it('repairs null ids from legacy rows and preserves scheduled_at during schema rebuild', () => {
    const db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    db.exec(`CREATE TABLE social_posts (
      id               TEXT PRIMARY KEY,
      platform         TEXT NOT NULL CHECK(platform IN ('linkedin', 'twitter')),
      content          TEXT NOT NULL,
      media_url        TEXT,
      suggested_time   TEXT,
      cta              TEXT,
      status           TEXT NOT NULL DEFAULT 'draft'
                       CHECK(status IN ('draft', 'approved', 'published', 'rejected', 'failed')),
      platform_post_id TEXT,
      platform_url     TEXT,
      error            TEXT,
      created_at       INTEGER NOT NULL,
      published_at     INTEGER,
      scheduled_at     INTEGER,
      created_by       TEXT NOT NULL DEFAULT 'social',
      project_id       TEXT NOT NULL DEFAULT 'default'
    )`)
    db.prepare(
      `INSERT INTO social_posts
         (id, platform, content, status, created_at, scheduled_at, created_by, project_id)
       VALUES (?, ?, ?, 'approved', ?, ?, 'legacy', ?)`,
    ).run(null, 'twitter', 'legacy scheduled row', 1_700_000_000_000, 1_700_000_600_000, 'default')

    initSocialTables(db)
    setSocialDb(db)

    const rows = db.prepare(
      'SELECT id, platform, scheduled_at FROM social_posts WHERE content = ?',
    ).all('legacy scheduled row') as Array<{ id: string | null; platform: string; scheduled_at: number | null }>

    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBeTruthy()
    expect(rows[0]!.platform).toBe('twitter')
    expect(rows[0]!.scheduled_at).toBe(1_700_000_600_000)
  })
})
