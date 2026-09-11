import { describe, it, expect } from 'vitest'
import { repoLines, renderReport, renderHistoryMarkdown } from './report.js'
import type { GithubDevRaw } from '../collectors/github-dev.js'
import type { RepoEvent } from '../../repo-events.js'

const raw: GithubDevRaw = {
  collected_for: ['Owner/a', 'Owner/b'],
  watermark: {},
  repos: [
    { repo: 'Owner/a', accessible: true,
      new_issues: [{ number: 1, title: 't', labels: [], author: 'x', self: false, createdAt: '', updatedAt: '' }],
      new_prs: [], new_comments: [], ci: { conclusion: 'success', workflow: 'ci', created_at: '' },
      dependabot_open: 0, is_mirror: false, mirror_drift: { drifted: false, mirror_last_commit_at: null }, errors: [] },
    { repo: 'Owner/b', accessible: true, new_issues: [], new_prs: [], new_comments: [],
      ci: { conclusion: 'failure', workflow: 'ci', created_at: '' }, dependabot_open: 2, is_mirror: false,
      mirror_drift: { drifted: true, mirror_last_commit_at: 1000 }, errors: [] },
  ],
}

const cards = [
  { status: 'in_progress', source: 'github:Owner/a' },
  { status: 'blocked', source: 'github:Owner/a' },
  { status: 'completed', source: 'github:Owner/b' },
]

const events: RepoEvent[] = [
  { id: 'e1', repo: 'Owner/a', kind: 'pr_opened', ref: 'url', actor: 'builder', item_id: 'c1', created_at: 2000 },
  { id: 'e2', repo: 'Owner/b', kind: 'issue_opened', ref: '#3', actor: 'external:someone', item_id: 'c2', created_at: 1000 },
]

describe('repoLines', () => {
  it('counts new, coded, waiting on you and shipped per repo', () => {
    const lines = repoLines(raw, cards, events)
    const a = lines.find(l => l.repo === 'Owner/a')!
    expect(a).toEqual({ repo: 'Owner/a', fresh: 1, coded: 1, waiting: 1, shipped: 0 })
    const b = lines.find(l => l.repo === 'Owner/b')!
    expect(b.shipped).toBe(1)
  })
})

describe('renderReport', () => {
  it('writes one plain line per repo, no markdown and no dashes', () => {
    const text = renderReport(repoLines(raw, cards, events))
    const rows = text.trim().split('\n')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toBe('Owner/a: 1 new, 1 coded, 1 waiting on you, 0 shipped')
    expect(text).not.toMatch(/[*`#–—]/)
  })

  it('leaves an underscore in a repo name alone, it is not markdown here', () => {
    const underscoreRaw: GithubDevRaw = {
      collected_for: ['YourGitHubUser/paw_trader'],
      watermark: {},
      repos: [{
        repo: 'YourGitHubUser/paw_trader', accessible: true,
        new_issues: [], new_prs: [], new_comments: [],
        ci: { conclusion: null, workflow: null, created_at: null },
        dependabot_open: 0, is_mirror: false, mirror_drift: { drifted: false, mirror_last_commit_at: null }, errors: [],
      }],
    }
    const text = renderReport(repoLines(underscoreRaw, [], []))
    expect(text).toContain('YourGitHubUser/paw_trader')
  })

  it('says so plainly when nothing happened', () => {
    expect(renderReport([])).toBe('No repo activity this cycle.')
  })
})

describe('renderHistoryMarkdown', () => {
  it('is a generated export with a warning header and both counts', () => {
    const md = renderHistoryMarkdown(events, [
      { repo: 'Owner/b', kind: 'issue_opened', actor_class: 'external', n: 1 },
      { repo: 'Owner/a', kind: 'pr_opened', actor_class: 'self', n: 1 },
    ], 1_700_000_000_000)
    expect(md).toMatch(/generated from the repo_events table/i)
    expect(md).toMatch(/do not edit/i)
    expect(md).toContain('external')
    expect(md).toContain('Owner/b')
    expect(md).not.toMatch(/[–—]/)
  })

  it('does not let a ref or actor forge a table row', () => {
    const evil: RepoEvent[] = [
      { id: 'e3', repo: 'Owner/a', kind: 'pr_opened', ref: 'url|extra\n| injected | row |', actor: 'external:mallory\n| fake | row |', item_id: 'c3', created_at: 3000 },
    ]
    const md = renderHistoryMarkdown(evil, [], 1_700_000_000_000)
    const eventRows = md.split('## Events')[1]!.split('\n').filter(l => l.startsWith('| 1970'))
    expect(eventRows).toHaveLength(1)
    expect(eventRows[0]).not.toContain('\n')
  })
})
