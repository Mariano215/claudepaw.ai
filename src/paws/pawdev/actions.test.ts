import { describe, it, expect, vi, beforeEach } from 'vitest'

const transitions: Array<{ id: string; to: string }> = []
/** Cards whose status the transition mock keeps current, so a double tap sees the real state. */
const liveCards = new Map<string, { status: string }>()
const events: Array<Record<string, unknown>> = []
const audits: Array<Record<string, unknown>> = []
let policy: 'auto' | 'ask' | 'never' = 'ask'

vi.mock('../../action-items.js', () => ({
  transitionActionItem: vi.fn((id: string, to: string) => {
    transitions.push({ id, to })
    const c = liveCards.get(id); if (c) c.status = to
  }),
}))
vi.mock('../../db.js', () => ({
  updateActionItemFields: vi.fn(),
  getKnob: vi.fn(() => 'Owner/repo-a,YourGitHubUser/claudepaw.ai'),
}))
vi.mock('../../repo-events.js', () => ({ writeRepoEvent: vi.fn((e: Record<string, unknown>) => { events.push(e); return 'ev' }) }))
vi.mock('../../policy.js', () => ({
  policyFor: vi.fn(() => policy),
  writeAudit: vi.fn((row: Record<string, unknown>) => { audits.push(row); return 1 }),
}))
vi.mock('../../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../handlers/pawdev-builder.js', () => ({ pawdevGhEnv: vi.fn(() => ({})) }))

import {
  executePawdevAction, pawdevApprovalRows, isAskExpired, isPawdevAction, PAWDEV_ACTION_LABELS,
} from './actions.js'
import type { ShellRunner } from '../handlers/pawdev-builder.js'
import type { AskCard } from './actions.js'
import { PROJECT_ROOT } from '../../config.js'

const CARD: AskCard = {
  id: 'c1', title: 'Owner/repo-a#42 Crash', created_at: Date.now(), last_run_at: null,
  description: 'REPLY DRAFT: thanks, fixed in #9\n\nrepo Owner/repo-a\nref #42',
  external_ref: JSON.stringify({ issue: 'github:Owner/repo-a#42', pr: 'https://github.com/Owner/repo-a/pull/9' }),
  status: 'blocked',
}
const MIRROR_CARD: AskCard = {
  id: 'c2', title: 'YourGitHubUser/claudepaw.ai#7 Contributor PR ported', created_at: Date.now(), last_run_at: null,
  description: null,
  external_ref: JSON.stringify({ issue: 'github:YourGitHubUser/claudepaw.ai#7', pr: '' }),
  status: 'blocked',
}
const deps = (sh: ShellRunner, card = CARD) => ({ sh, card: (id: string) => (id === card.id ? card : null) })

beforeEach(() => { transitions.length = 0; events.length = 0; audits.length = 0; policy = 'ask'; liveCards.clear() })

describe('pawdevApprovalRows', () => {
  it('offers the four ask steps with their exact labels', () => {
    const rows = pawdevApprovalRows(['c1'])
    const labels = rows.flat().map(b => b.text)
    expect(labels).toEqual([
      PAWDEV_ACTION_LABELS.reply, PAWDEV_ACTION_LABELS.merge,
      PAWDEV_ACTION_LABELS.mirror, PAWDEV_ACTION_LABELS.close,
    ])
    expect(rows.flat().map(b => b.callback_data)).toContain('pawdev:merge:c1')
  })

  it('renders nothing when there is no card to act on', () => {
    expect(pawdevApprovalRows([])).toEqual([])
  })
})

describe('isPawdevAction', () => {
  it('accepts the four names and nothing else', () => {
    for (const a of Object.keys(PAWDEV_ACTION_LABELS)) expect(isPawdevAction(a)).toBe(true)
    expect(isPawdevAction('delete')).toBe(false)
    expect(isPawdevAction('')).toBe(false)
  })
})

describe('isAskExpired', () => {
  it('follows the routine approval timeout', () => {
    const now = 1_000_000
    expect(isAskExpired(now - 400_000, 300, now)).toBe(true)
    expect(isAskExpired(now - 100_000, 300, now)).toBe(false)
    expect(isAskExpired(null, 300, now)).toBe(false)
  })
})

describe('executePawdevAction', () => {
  it('refuses an expired ask before any gh call', async () => {
    const seen: string[][] = []
    const sh: ShellRunner = async (c, a) => { seen.push([c, ...a]); return { code: 0, stdout: '', stderr: '' } }
    const stale: AskCard = { ...CARD, last_run_at: Date.now() - 3 * 24 * 60 * 60 * 1000 }
    const out = await executePawdevAction('merge', 'c1', deps(sh, stale))
    expect(out).toEqual({ ok: false, message: 'this ask expired' })
    expect(seen).toEqual([])
    expect(audits).toEqual([])
  })


  it('merge runs gh directly, never the wrapper, and records pr_merged', async () => {
    const seen: string[][] = []
    const sh: ShellRunner = async (c, a) => { seen.push([c, ...a]); return { code: 0, stdout: 'merged', stderr: '' } }
    const out = await executePawdevAction('merge', 'c1', deps(sh))
    expect(out.ok).toBe(true)
    expect(seen[0].join(' ')).toBe('gh pr merge 9 -R Owner/repo-a --squash --delete-branch')
    expect(seen[0]).not.toContain('gh-wrapper.sh')
    expect(events).toEqual([expect.objectContaining({ kind: 'pr_merged', repo: 'Owner/repo-a', actor: 'human' })])
    expect(transitions).toEqual([{ id: 'c1', to: 'in_progress' }, { id: 'c1', to: 'completed' }])
    expect(audits).toEqual([expect.objectContaining({ decision: 'allow', actor: 'human', ref_table: 'action_items', ref_id: 'c1' })])
    // Merge has its own action class so a project that sets code.pr to auto
    // for the builder does not also hand out merge.
    expect(audits[0]).toMatchObject({ action_class: 'code.merge' })
  })

  it('a second tap on reply does nothing, because the first tap completed the card', async () => {
    const seen: string[][] = []
    const sh: ShellRunner = async (c, a) => { seen.push([c, ...a]); return { code: 0, stdout: '', stderr: '' } }
    const card: AskCard = { ...CARD }
    liveCards.set(card.id, card)
    const d = { sh, card: (id: string) => (id === card.id ? card : null) }

    const first = await executePawdevAction('reply', 'c1', d)
    expect(first.ok).toBe(true)
    expect(transitions).toEqual([{ id: 'c1', to: 'in_progress' }, { id: 'c1', to: 'completed' }])

    const second = await executePawdevAction('reply', 'c1', d)
    expect(second).toEqual({ ok: false, message: 'already handled' })
    expect(seen).toHaveLength(1)
    expect(audits).toHaveLength(1)
  })

  it('reply posts the draft the triage soul wrote and records reply_posted', async () => {
    const seen: string[][] = []
    const sh: ShellRunner = async (c, a) => { seen.push([c, ...a]); return { code: 0, stdout: '', stderr: '' } }
    const out = await executePawdevAction('reply', 'c1', deps(sh))
    expect(out.ok).toBe(true)
    const joined = seen[0].join(' ')
    expect(joined).toContain('gh issue comment 42 -R Owner/repo-a')
    expect(joined).toContain('thanks, fixed in #9')
    expect(events[0]).toMatchObject({ kind: 'reply_posted', ref: '#42' })
    expect(transitions).toEqual([{ id: 'c1', to: 'in_progress' }, { id: 'c1', to: 'completed' }])
  })

  it('mirror regeneration runs the sync script from the project root, never a push to the mirror', async () => {
    const seen: string[][] = []
    let cwdSeen: string | undefined
    const sh: ShellRunner = async (c, a, cwd) => { seen.push([c, ...a]); cwdSeen = cwd; return { code: 0, stdout: '', stderr: '' } }
    await executePawdevAction('mirror', 'c2', deps(sh, MIRROR_CARD))
    expect(seen[0].join(' ')).toMatch(/npm run sync:/)
    expect(cwdSeen).toBe(PROJECT_ROOT)
    expect(seen.flat().some(s => s === 'push')).toBe(false)
    expect(events[0]).toMatchObject({ kind: 'mirror_synced' })
  })

  it('close issue records issue_closed and completes the card', async () => {
    const sh: ShellRunner = async () => ({ code: 0, stdout: '', stderr: '' })
    await executePawdevAction('close', 'c1', deps(sh))
    expect(events[0]).toMatchObject({ kind: 'issue_closed', ref: '#42' })
    expect(transitions).toEqual([{ id: 'c1', to: 'in_progress' }, { id: 'c1', to: 'completed' }])
  })

  it('a policy of never performs nothing and says so', async () => {
    policy = 'never'
    const seen: string[][] = []
    const sh: ShellRunner = async (c, a) => { seen.push([c, ...a]); return { code: 0, stdout: '', stderr: '' } }
    const out = await executePawdevAction('merge', 'c1', deps(sh))
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/policy/i)
    expect(seen).toEqual([])
    expect(events).toEqual([])
    expect(audits).toEqual([])
  })

  it('a card that is not blocked is refused before any sh call or audit row (double tap)', async () => {
    const seen: string[][] = []
    const sh: ShellRunner = async (c, a) => { seen.push([c, ...a]); return { code: 0, stdout: '', stderr: '' } }
    const completed: AskCard = { ...CARD, status: 'completed' }
    const out = await executePawdevAction('merge', 'c1', deps(sh, completed))
    expect(out.ok).toBe(false)
    expect(out.message).toBe('already handled')
    expect(seen).toEqual([])
    expect(audits).toEqual([])
  })

  it('refuses a repo that is not on the pawdev repo list', async () => {
    const sh: ShellRunner = async () => ({ code: 0, stdout: '', stderr: '' })
    const stranger = { ...CARD, external_ref: JSON.stringify({ issue: 'github:Someone/else#1', pr: '' }) }
    const out = await executePawdevAction('close', 'c1', deps(sh, stranger))
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/not configured/i)
  })

  it('a failing command leaves the card blocked and reports the exit code', async () => {
    const sh: ShellRunner = async () => ({ code: 1, stdout: '', stderr: 'not mergeable' })
    const out = await executePawdevAction('merge', 'c1', deps(sh))
    expect(out.ok).toBe(false)
    expect(out.message).toContain('not mergeable')
    expect(transitions).toEqual([])
  })
})
