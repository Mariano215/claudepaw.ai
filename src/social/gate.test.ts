import { describe, it, expect, vi, beforeEach } from 'vitest'

const decisions = new Map<string, string>()
const calls: Array<{ project: string; cls: string; actor: string }> = []

vi.mock('../policy.js', () => ({
  checkAction: vi.fn(async (project: string, cls: string, actor: string) => {
    calls.push({ project, cls, actor })
    return decisions.get(cls) ?? 'allow'
  }),
}))

const marked: string[] = []
vi.mock('./db.js', async (orig) => {
  const actual = await orig<typeof import('./db.js')>()
  return {
    ...actual,
    getPost: vi.fn((id: string) => ({ id, status: 'draft', platform: 'linkedin', project_id: 'default', content: 'x' })),
    markApprovedScheduled: vi.fn((id: string) => { marked.push(id); return true }),
  }
})

const feedItems: Array<{ actor: string }> = []
vi.mock('../dashboard.js', () => ({
  reportFeedItem: vi.fn((actor: string) => { feedItems.push({ actor }) }),
  reportMetric: vi.fn(),
}))

import { autoApproveAndSchedule } from './index.js'

describe('social.post gate inside autoApproveAndSchedule', () => {
  beforeEach(() => { decisions.clear(); calls.length = 0; marked.length = 0; feedItems.length = 0 })

  it('queues the post when the policy is auto', async () => {
    const res = await autoApproveAndSchedule('p1')
    expect(res.queued).toBe(true)
    expect(marked).toEqual(['p1'])
    expect(calls[0]).toMatchObject({ project: 'default', cls: 'social.post' })
    expect(feedItems[0]).toEqual({ actor: 'social-writer' })
  })

  it('parks on ask and never marks the post approved', async () => {
    decisions.set('social.post', 'pending:card-7')
    const res = await autoApproveAndSchedule('p1')
    expect(res.queued).toBe(false)
    expect(res.parked).toBe('card-7')
    expect(marked).toEqual([])
  })

  it('refuses on never and never marks the post approved', async () => {
    decisions.set('social.post', 'deny')
    const res = await autoApproveAndSchedule('p1')
    expect(res.queued).toBe(false)
    expect(res.parked).toBeUndefined()
    expect(marked).toEqual([])
  })
})
