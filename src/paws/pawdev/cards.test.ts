import { describe, it, expect } from 'vitest'
import { parseTriageFindings, planCards, isGrounded, externalRefFor, type TriageFinding } from './cards.js'
import type { GithubDevRaw } from '../collectors/github-dev.js'

const raw: GithubDevRaw = {
  collected_for: ['Owner/repo-a'],
  watermark: { 'Owner/repo-a': 1 },
  repos: [{
    repo: 'Owner/repo-a', accessible: true,
    new_issues: [
      { number: 42, title: 'Crash', labels: ['bug'], author: 'headlinearena', self: false, createdAt: 'x', updatedAt: 'x' },
      { number: 7, title: 'Self note', labels: [], author: 'YourGitHubUser', self: true, createdAt: 'x', updatedAt: 'x' },
      { number: 3, title: 'Real issue three', labels: [], author: 'headlinearena', self: false, createdAt: 'x', updatedAt: 'x' },
    ],
    new_prs: [], new_comments: [],
    ci: { conclusion: 'success', workflow: 'ci', created_at: 'x' },
    dependabot_open: 0, is_mirror: false,
    mirror_drift: { drifted: false, mirror_last_commit_at: null },
    errors: [],
  }],
}

function finding(over: Partial<TriageFinding> = {}): TriageFinding {
  return {
    id: 'Owner/repo-a#42', severity: 3, title: 'Crash', detail: 'repro: run x',
    repo: 'Owner/repo-a', kind: 'bug', ref: '#42', effort: 'small',
    proposed_column: 'approved', ...over,
  }
}

describe('parseTriageFindings', () => {
  it('reads the JSON object the triage soul emits, fences and all', () => {
    const text = '```json\n{"findings":[{"id":"a#1","severity":3,"title":"t","detail":"d","repo":"a/b","kind":"bug","ref":"#1","effort":"trivial","proposed_column":"approved"}]}\n```'
    const out = parseTriageFindings(text)
    expect(out).toHaveLength(1)
    expect(out[0].effort).toBe('trivial')
  })

  it('returns an empty list rather than throwing on prose', () => {
    expect(parseTriageFindings('I looked at the repos and everything is fine.')).toEqual([])
  })

  it('drops a finding with an unknown effort or column instead of guessing', () => {
    const text = JSON.stringify({ findings: [{ id: 'a#1', severity: 3, title: 't', detail: 'd', repo: 'a/b', kind: 'bug', ref: '#1', effort: 'enormous', proposed_column: 'approved' }] })
    expect(parseTriageFindings(text)).toEqual([])
  })
})

describe('planCards', () => {
  it('opens an approved card for an external item with a repro', () => {
    const plans = planCards([finding()], raw, new Set())
    expect(plans).toHaveLength(1)
    expect(plans[0].input.initial_status).toBe('approved')
    expect(plans[0].input.project_id).toBe('pawdev')
    expect(plans[0].input.executable_by_agent).toBe(true)
    expect(plans[0].external_ref).toBe('github:Owner/repo-a#42')
    expect(plans[0].event).toEqual({ repo: 'Owner/repo-a', kind: 'issue_opened', ref: '#42', actor: 'external:headlinearena' })
  })

  it('never advances a self-filed item past Triaged', () => {
    const plans = planCards([finding({ id: 'Owner/repo-a#7', ref: '#7', proposed_column: 'approved' })], raw, new Set())
    expect(plans[0].input.initial_status).toBe('proposed')
    expect(plans[0].event!.actor).toBe('triage')
  })

  it('leaves medium and large work for a human session', () => {
    const plans = planCards([finding({ effort: 'medium' })], raw, new Set())
    expect(plans[0].input.initial_status).toBe('proposed')
    expect(plans[0].input.description).toContain('effort medium')
  })

  it('is idempotent: an external_ref that already has a card is skipped', () => {
    const plans = planCards([finding()], raw, new Set(['github:Owner/repo-a#42']))
    expect(plans).toEqual([])
  })

  it('drops noise instead of opening a card for it', () => {
    expect(planCards([finding({ kind: 'noise', severity: 1 })], raw, new Set())).toEqual([])
  })

  it('drops a finding whose repo the collector never covered', () => {
    const plans = planCards([finding({ repo: 'Owner/unknown-repo' })], raw, new Set())
    expect(plans).toEqual([])
  })

  it('drops a finding whose ref matches no item in a known repo', () => {
    const plans = planCards([finding({ ref: '#999' })], raw, new Set())
    expect(plans).toEqual([])
  })

  it('still plans a grounded finding', () => {
    const plans = planCards([finding()], raw, new Set())
    expect(plans).toHaveLength(1)
  })

  it('dedupes two findings on the same repo and ref within one batch', () => {
    const plans = planCards(
      [finding({ id: 'a' }), finding({ id: 'b', kind: 'security' })],
      raw,
      new Set(),
    )
    expect(plans).toHaveLength(1)
  })
})

describe('isGrounded', () => {
  it('grounds a clean ref that matches a real issue', () => {
    expect(isGrounded(finding({ ref: '#42' }), raw)).toBe(true)
    expect(isGrounded(finding({ ref: '42' }), raw)).toBe(true)
  })

  it('treats a ref padded with whitespace or a newline as ungrounded', () => {
    expect(isGrounded(finding({ ref: '\n3' }), raw)).toBe(false)
    expect(isGrounded(finding({ ref: '3 ' }), raw)).toBe(false)
  })
})

describe('externalRefFor', () => {
  it('builds the stable key both directions of the sync agree on', () => {
    expect(externalRefFor('Owner/repo-a', '#42')).toBe('github:Owner/repo-a#42')
    expect(externalRefFor('Owner/repo-a', '42')).toBe('github:Owner/repo-a#42')
  })
})
