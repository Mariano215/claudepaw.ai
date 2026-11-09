import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

const db = new Database(':memory:')
vi.mock('./db.js', () => ({ getDb: () => db }))
vi.mock('./logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('./config.js', () => ({ DASHBOARD_URL: '', BOT_API_TOKEN: '', DASHBOARD_API_TOKEN: '' }))

import { writeRepoEvent, listRepoEvents, repoEventStats, REPO_EVENTS_DDL } from './repo-events.js'

describe('repo_events', () => {
  beforeEach(() => {
    db.exec('DROP TABLE IF EXISTS repo_events')
    db.exec(REPO_EVENTS_DDL)
  })

  it('writes one row and reads it back newest first', () => {
    writeRepoEvent({ repo: 'YourGitHubUser/paw-trader', kind: 'issue_opened', ref: '#1', actor: 'external:headlinearena', created_at: 1000 })
    const id = writeRepoEvent({ repo: 'YourGitHubUser/paw-trader', kind: 'pr_opened', ref: 'https://x/1', actor: 'builder', created_at: 2000 })

    const rows = listRepoEvents({ repo: 'YourGitHubUser/paw-trader' })
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe(id)
    expect(rows[0].kind).toBe('pr_opened')
    expect(rows[1].actor).toBe('external:headlinearena')
  })

  it('filters by repo and by time', () => {
    writeRepoEvent({ repo: 'a/b', kind: 'ci_failed', actor: 'maintainer', created_at: 500 })
    writeRepoEvent({ repo: 'c/d', kind: 'ci_failed', actor: 'maintainer', created_at: 1500 })
    expect(listRepoEvents({ sinceMs: 1000 })).toHaveLength(1)
    expect(listRepoEvents({ repo: 'a/b' })).toHaveLength(1)
  })

  it('counts external and self separately so the loop cannot look busy', () => {
    writeRepoEvent({ repo: 'a/b', kind: 'issue_opened', actor: 'external:someone', created_at: 10 })
    writeRepoEvent({ repo: 'a/b', kind: 'issue_opened', actor: 'triage', created_at: 20 })
    writeRepoEvent({ repo: 'a/b', kind: 'issue_opened', actor: 'human', created_at: 30 })

    const stats = repoEventStats(0)
    const ext = stats.find(s => s.actor_class === 'external')!
    const self = stats.find(s => s.actor_class === 'self')!
    expect(ext.n).toBe(1)
    expect(self.n).toBe(2)
  })
})
