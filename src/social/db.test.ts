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
})
