import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  initCommentsTable, ingestComments, hasAnyComments, getComment, setCommentStatus,
  ignoreComment, sendCommentReply, isSensitive, isNoise, buildCard, type FetchedComment,
} from './comments.js'

const c = (id: string, text = 'Loved the trailer, when is the premiere?'): FetchedComment => ({
  platform: 'instagram', platform_comment_id: `ig:${id}`, post_ref: 'https://instagram.com/p/x',
  author: '@fan', text, created_at: 1,
})

describe('social/comments', () => {
  beforeEach(() => initCommentsTable(new Database(':memory:')))

  it('dedupes on platform_comment_id and returns only new rows', () => {
    expect(hasAnyComments('example-company', 'instagram')).toBe(false)
    expect(ingestComments('example-company', [c('1'), c('2')])).toHaveLength(2)
    const again = ingestComments('example-company', [c('1'), c('2'), c('3')])
    expect(again.map((r) => r.platform_comment_id)).toEqual(['ig:3'])
    expect(hasAnyComments('example-company', 'instagram')).toBe(true)
  })

  it('status transitions: drafted keeps its reply, ignore only from open states', () => {
    const [row] = ingestComments('example-company', [c('1')])
    setCommentStatus(row.id, 'drafted', 'Thank you! Premiere date drops Friday.')
    expect(getComment(row.id)).toMatchObject({ status: 'drafted', draft_reply: 'Thank you! Premiere date drops Friday.' })
    setCommentStatus(row.id, 'replied')
    expect(getComment(row.id)!.replied_at).toBeGreaterThan(0)
    expect(ignoreComment(row.id)).toBe(false)
  })

  it('refuses to send a reply that is not in drafted state (double tap guard)', async () => {
    const [row] = ingestComments('example-company', [c('1')])
    setCommentStatus(row.id, 'replied', 'hi')
    expect(await sendCommentReply(row.id)).toMatchObject({ ok: false })
  })

  it('flags money, legal and client talk; skips noise', () => {
    expect(isSensitive('How much does a pentest cost?')).toBe(true)
    expect(isSensitive('My lawyer will be in touch')).toBe(true)
    expect(isSensitive('It was $50 at the door')).toBe(true)
    expect(isSensitive('Beautiful cinematography')).toBe(false)
    expect(isNoise('🔥🔥🔥')).toBe(true)
    expect(isNoise('@friend')).toBe(true)
    expect(isNoise('wow')).toBe(true)
    expect(isNoise('so good')).toBe(false)
  })

  it('flagged card has no Reply button', () => {
    const [row] = ingestComments('example-company', [c('1')])
    const flagged = buildCard(row, 'Example Company', true)
    expect(flagged.keyboard.inline_keyboard[0].map((b) => b.callback_data)).toEqual([`social:cignore:${row.id}`])
    const normal = buildCard({ ...row, draft_reply: 'Thanks!' }, 'Example Company', false)
    expect(normal.keyboard.inline_keyboard[0][0].callback_data).toBe(`social:creply:${row.id}`)
    expect(normal.text).toContain('Draft reply:\nThanks!')
  })
})
