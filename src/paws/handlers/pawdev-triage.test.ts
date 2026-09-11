import { describe, it, expect, vi, beforeEach } from 'vitest'

const created: Array<Record<string, unknown>> = []
const fieldUpdates: Array<{ id: string; f: Record<string, unknown> }> = []
const events: Array<Record<string, unknown>> = []
const transitions: Array<{ id: string; to: string }> = []
let shellResult: { code: number; stdout: string; stderr: string } = { code: 0, stdout: 'diff --git a/x b/x', stderr: '' }
let agentText = '{"verdict":"port","notes":"looks fine"}'

vi.mock('../../action-items.js', () => ({
  createActionItem: vi.fn((input: Record<string, unknown>) => {
    const id = `item-${created.length + 1}`
    created.push({ id, ...input, status: input.initial_status })
    return id
  }),
  transitionActionItem: vi.fn((id: string, to: string) => {
    transitions.push({ id, to })
    const c = created.find(x => x.id === id); if (c) c.status = to
  }),
}))
vi.mock('../../policy.js', () => ({
  policyFor: vi.fn(() => 'ask'),
  writeAudit: vi.fn(),
}))
vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  getKnob: vi.fn(() => 'YourGitHubUser/paw-trader'),
  listActionItems: vi.fn((o: { includeArchived?: boolean }) => (o.includeArchived ? existingRows : [])),
  updateActionItemFields: vi.fn((id: string, f: Record<string, unknown>) => { fieldUpdates.push({ id, f }) }),
}))
vi.mock('../pawdev/cards.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  observeRawForCycle: vi.fn(() => observeRaw),
}))
vi.mock('../../repo-events.js', () => ({ writeRepoEvent: vi.fn((e: Record<string, unknown>) => { events.push(e); return 'ev1' }) }))
vi.mock('../../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('./pawdev-builder.js', () => ({
  realShell: vi.fn(async () => shellResult),
  pawdevGhEnv: vi.fn(() => ({ GH_TOKEN: 'ghp_test' })),
}))
vi.mock('../../agent.js', () => ({ runAgent: vi.fn(async () => ({ text: agentText })) }))
vi.mock('../../souls.js', () => ({ getSoul: vi.fn(() => undefined), buildAgentPrompt: vi.fn(() => '') }))

import { openPortCard, pawdevTriageHandler } from './pawdev-triage.js'
import { executePawdevAction, type AskCard } from '../pawdev/actions.js'
import type { ShellRunner } from './pawdev-builder.js'
import type { DevPr, GithubDevRaw, GithubDevRepo } from '../collectors/github-dev.js'

const sends: Array<{ chatId: string; text: string; keyboard: unknown }> = []
vi.mock('../pawdev/actions.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getPawdevCardSender: vi.fn(() => async (chatId: string, text: string, keyboard: unknown) => {
    sends.push({ chatId, text, keyboard })
  }),
}))
vi.mock('../db.js', () => ({ getPaw: vi.fn(() => ({ id: 'paw-dev-cycle', project_id: 'pawdev', config: { chat_id: 'chat1' } })) }))

let observeRaw: GithubDevRaw | null = null
/** Rows only an includeArchived read returns. */
let existingRows: Array<{ external_ref: string | null }> = []

function repo(over: Partial<GithubDevRepo> = {}): GithubDevRepo {
  return {
    repo: 'YourGitHubUser/paw-trader', accessible: true,
    new_issues: [], new_prs: [], new_comments: [],
    ci: { conclusion: 'success', workflow: 'ci', created_at: 'x' },
    dependabot_open: 0, is_mirror: true,
    mirror_drift: { drifted: false, mirror_last_commit_at: null },
    errors: [], ...over,
  }
}

function prAt(number: number, createdAt: string): DevPr {
  return {
    number, title: `PR ${number}`, labels: [], author: 'headlinearena', self: false,
    createdAt, updatedAt: createdAt, headRefName: `b${number}`, from_fork: true,
  }
}

function analyze(findings: Array<Record<string, unknown>>): string {
  return JSON.stringify({ findings })
}

const pr: DevPr = {
  number: 5, title: 'Add docs', labels: [], author: 'headlinearena', self: false,
  createdAt: '2026-09-09T12:00:00Z', updatedAt: '2026-09-09T12:00:00Z',
  headRefName: 'docs', from_fork: true,
}

beforeEach(() => {
  sends.length = 0
  transitions.length = 0
  observeRaw = null
  existingRows = []
  created.length = 0
  fieldUpdates.length = 0
  events.length = 0
  shellResult = { code: 0, stdout: 'diff --git a/x b/x', stderr: '' }
  agentText = '{"verdict":"port","notes":"looks fine"}'
})

describe('openPortCard', () => {
  it('skips a pull request that already has a card', async () => {
    const existing = new Set(['github:YourGitHubUser/paw-trader#5'])
    await openPortCard('YourGitHubUser/paw-trader', pr, existing)
    expect(created).toHaveLength(0)
  })

  it('falls back to a port card when the reviewer returns no JSON', async () => {
    agentText = 'not json'
    const existing = new Set<string>()
    await openPortCard('YourGitHubUser/paw-trader', pr, existing)
    expect(created).toHaveLength(1)
    expect(String(created[0].description)).toContain('reviewer returned no JSON')
    expect(existing.has('github:YourGitHubUser/paw-trader#5')).toBe(true)
  })

  it('uses a valid LLM coauthor when the reviewer supplies one', async () => {
    agentText = '{"verdict":"port","coauthor":"Someone Else <se@example.com>"}'
    const existing = new Set<string>()
    await openPortCard('YourGitHubUser/paw-trader', pr, existing)
    expect(String(created[0].description)).toContain('Co-authored-by: Someone Else <se@example.com>')
  })

  it('ignores an invalid LLM coauthor and falls back to the pull request author', async () => {
    agentText = '{"verdict":"port","coauthor":"bad; rm -rf / #"}'
    const existing = new Set<string>()
    await openPortCard('YourGitHubUser/paw-trader', pr, existing)
    expect(String(created[0].description)).toContain('Co-authored-by: headlinearena <headlinearena@users.noreply.github.com>')
  })
})

describe('pawdevTriageHandler', () => {
  it('reviews at most three contributor pull requests a cycle, oldest first', async () => {
    observeRaw = {
      collected_for: ['YourGitHubUser/paw-trader'],
      watermark: {},
      repos: [repo({
        new_prs: [
          prAt(5, '2026-09-05T00:00:00Z'),
          prAt(1, '2026-09-01T00:00:00Z'),
          prAt(4, '2026-09-04T00:00:00Z'),
          prAt(2, '2026-09-02T00:00:00Z'),
          prAt(3, '2026-09-03T00:00:00Z'),
        ],
      })],
    }

    await pawdevTriageHandler('cy1', 'paw-dev-cycle', 'pawdev', analyze([]))

    expect(created).toHaveLength(3)
    expect(created.map(c => String(c.title))).toEqual([
      'YourGitHubUser/paw-trader#1 port PR 1',
      'YourGitHubUser/paw-trader#2 port PR 2',
      'YourGitHubUser/paw-trader#3 port PR 3',
    ])
  })

  it('opens one card, not two, for a contributor pull request the triage soul also reported', async () => {
    observeRaw = {
      collected_for: ['YourGitHubUser/paw-trader'],
      watermark: {},
      repos: [repo({ new_prs: [prAt(5, '2026-09-05T00:00:00Z')] })],
    }

    await pawdevTriageHandler('cy1', 'paw-dev-cycle', 'pawdev', analyze([{
      id: 'YourGitHubUser/paw-trader#5', severity: 4, title: 'PR 5', detail: 'a contributor pull request',
      repo: 'YourGitHubUser/paw-trader', kind: 'contributor_pr', ref: '#5', effort: 'medium', proposed_column: 'proposed',
    }]))

    expect(created).toHaveLength(1)
  })

  it('sends one ask per card with a reply draft, carrying the draft text', async () => {
    observeRaw = {
      collected_for: ['YourGitHubUser/paw-trader'],
      watermark: {},
      repos: [repo({
        new_issues: [
          { number: 11, title: 'How do I run it', labels: [], author: 'headlinearena', self: false, createdAt: 'x', updatedAt: 'x' },
          { number: 12, title: 'Does it support X', labels: [], author: 'headlinearena', self: false, createdAt: 'x', updatedAt: 'x' },
        ],
      })],
    }

    await pawdevTriageHandler('cy1', 'paw-dev-cycle', 'pawdev', analyze([11, 12].map(n => ({
      id: `YourGitHubUser/paw-trader#${n}`, severity: 3, title: `Question ${n}`,
      detail: `REPLY DRAFT: Run npm start.\nThen open the dashboard.`,
      repo: 'YourGitHubUser/paw-trader', kind: 'question', ref: `#${n}`, effort: 'small', proposed_column: 'proposed',
    }))))

    expect(sends).toHaveLength(2)
    expect(sends[0].chatId).toBe('chat1')
    expect(sends[0].text).toContain('YourGitHubUser/paw-trader#11: Question 11')
    expect(sends[0].text).toContain('Draft reply:')
    expect(sends[0].text).toContain('Run npm start.\nThen open the dashboard.')
    expect(sends[0].text).not.toContain('*')
    expect(sends[0].keyboard).toEqual({ inline_keyboard: expect.any(Array) })

    // The buttons are dead unless the card is on `blocked`, which is the only
    // status executePawdevAction acts on. proposed -> blocked is illegal, so
    // the handler goes through approved first.
    expect(transitions.filter(t => t.id === 'item-1')).toEqual([
      { id: 'item-1', to: 'approved' }, { id: 'item-1', to: 'blocked' },
    ])
    expect(fieldUpdates.some(u => u.id === 'item-1' && u.f.last_run_result === 'awaiting: reply')).toBe(true)
  })

  it('leaves an approved draft card in the build queue and sends it no ask', async () => {
    observeRaw = {
      collected_for: ['YourGitHubUser/paw-trader'],
      watermark: {},
      repos: [repo({
        new_issues: [
          { number: 11, title: 'Question', labels: [], author: 'headlinearena', self: false, createdAt: 'x', updatedAt: 'x' },
          { number: 12, title: 'Small bug', labels: [], author: 'headlinearena', self: false, createdAt: 'x', updatedAt: 'x' },
        ],
      })],
    }

    await pawdevTriageHandler('cy1', 'paw-dev-cycle', 'pawdev', analyze([
      {
        id: 'YourGitHubUser/paw-trader#11', severity: 3, title: 'Question', detail: 'REPLY DRAFT: Run npm start.',
        repo: 'YourGitHubUser/paw-trader', kind: 'question', ref: '#11', effort: 'small', proposed_column: 'proposed',
      },
      {
        id: 'YourGitHubUser/paw-trader#12', severity: 3, title: 'Small bug', detail: 'REPLY DRAFT: on it, repro is clear',
        repo: 'YourGitHubUser/paw-trader', kind: 'bug', ref: '#12', effort: 'small', proposed_column: 'approved',
      },
    ]))

    expect(created).toHaveLength(2)
    // The proposed one becomes an ask.
    expect(created.find(c => c.id === 'item-1')!.status).toBe('blocked')
    // The approved one is queued for the builder, which reads only approved.
    // Blocking it here would mean it is never built.
    expect(created.find(c => c.id === 'item-2')!.status).toBe('approved')
    expect(transitions.some(t => t.id === 'item-2')).toBe(false)
    expect(sends).toHaveLength(1)
    expect(sends[0].text).toContain('#11')
  })

  it('the ask button on a card it just sent actually runs, it is not already handled', async () => {
    observeRaw = {
      collected_for: ['YourGitHubUser/paw-trader'],
      watermark: {},
      repos: [repo({
        new_issues: [{ number: 11, title: 'How do I run it', labels: [], author: 'headlinearena', self: false, createdAt: 'x', updatedAt: 'x' }],
      })],
    }

    await pawdevTriageHandler('cy1', 'paw-dev-cycle', 'pawdev', analyze([{
      id: 'YourGitHubUser/paw-trader#11', severity: 3, title: 'Question', detail: 'REPLY DRAFT: Run npm start.',
      repo: 'YourGitHubUser/paw-trader', kind: 'question', ref: '#11', effort: 'small', proposed_column: 'proposed',
    }]))

    const row = created.find(c => c.id === 'item-1')!
    const askCard: AskCard = {
      id: 'item-1',
      title: String(row.title),
      description: String(row.description),
      external_ref: String(fieldUpdates.find(u => u.id === 'item-1' && u.f.external_ref)!.f.external_ref),
      status: String(row.status),
      created_at: Date.now(),
      last_run_at: Date.now(),
    }
    const seen: string[][] = []
    const sh: ShellRunner = async (c, a) => { seen.push([c, ...a]); return { code: 0, stdout: '', stderr: '' } }

    const out = await executePawdevAction('reply', 'item-1', { sh, card: () => askCard })

    expect(out.ok).toBe(true)
    expect(seen[0].join(' ')).toContain('gh issue comment 11 -R YourGitHubUser/paw-trader')
    expect(seen[0].join(' ')).toContain('Run npm start.')
  })

  it('sends at most five asks a cycle and leaves the rest for the next one', async () => {
    const numbers = [21, 22, 23, 24, 25, 26]
    observeRaw = {
      collected_for: ['YourGitHubUser/paw-trader'],
      watermark: {},
      repos: [repo({
        new_issues: numbers.map(n => ({
          number: n, title: `Q${n}`, labels: [], author: 'headlinearena', self: false, createdAt: 'x', updatedAt: 'x',
        })),
      })],
    }

    await pawdevTriageHandler('cy1', 'paw-dev-cycle', 'pawdev', analyze(numbers.map(n => ({
      id: `YourGitHubUser/paw-trader#${n}`, severity: 3, title: `Q${n}`, detail: 'REPLY DRAFT: yes',
      repo: 'YourGitHubUser/paw-trader', kind: 'question', ref: `#${n}`, effort: 'small', proposed_column: 'proposed',
    }))))

    expect(created).toHaveLength(6)
    expect(sends).toHaveLength(5)
  })
})

describe('pawdevTriageHandler dedupe', () => {
  it('an archived card for the same issue stops a duplicate being opened', async () => {
    existingRows = [{ external_ref: JSON.stringify({ issue: 'github:YourGitHubUser/paw-trader#11' }) }]
    observeRaw = {
      collected_for: ['YourGitHubUser/paw-trader'],
      watermark: {},
      repos: [repo({
        new_issues: [{ number: 11, title: 'Crash', labels: [], author: 'headlinearena', self: false, createdAt: 'x', updatedAt: 'x' }],
      })],
    }

    await pawdevTriageHandler('cy1', 'paw-dev-cycle', 'pawdev', analyze([{
      id: 'YourGitHubUser/paw-trader#11', severity: 3, title: 'Crash', detail: 'repro',
      repo: 'YourGitHubUser/paw-trader', kind: 'bug', ref: '#11', effort: 'small', proposed_column: 'proposed',
    }]))

    expect(created).toHaveLength(0)
  })
})
