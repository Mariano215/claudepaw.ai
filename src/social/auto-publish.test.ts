import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  initSocialTables,
  setSocialDb,
  createDraft,
  getPost,
  markApprovedScheduled,
  listDueApproved,
} from './db.js'

describe('social auto-publish queue transition', () => {
  beforeEach(() => {
    const db = new Database(':memory:')
    initSocialTables(db)
    setSocialDb(db)
  })

  it('markApprovedScheduled flips a draft to approved + scheduled and it shows as due', () => {
    const post = createDraft({ platform: 'twitter', content: 'hello', project_id: 'default' })
    expect(post.status).toBe('draft')

    const at = Date.now()
    expect(markApprovedScheduled(post.id, at)).toBe(true)

    const updated = getPost(post.id)!
    expect(updated.status).toBe('approved')
    expect(updated.scheduled_at).toBe(at)

    const due = listDueApproved(at)
    expect(due.map((p) => p.id)).toContain(post.id)
  })

  it('is a no-op on a non-draft post (idempotent re-notify)', () => {
    const post = createDraft({ platform: 'linkedin', content: 'x', project_id: 'default' })
    expect(markApprovedScheduled(post.id, Date.now())).toBe(true)
    // Second call finds no draft row to move.
    expect(markApprovedScheduled(post.id, Date.now())).toBe(false)
  })
})
