import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const knobs = new Map<string, string>()

const cards = new Map<string, { id: string; status: string; source: string }>()
const updated: Array<{ id: string; fields: Record<string, unknown> }> = []
let signingAvailable = true

vi.mock('./replay-signing.js', () => ({
  canSignReplay: vi.fn(() => signingAvailable),
  signReplay: vi.fn((cardId: string) => `sig-for-${cardId}`),
}))

vi.mock('./db.js', () => ({
  getKnob: vi.fn((projectId: string, key: string, fallback: string) => knobs.get(`${projectId}:${key}`) ?? fallback),
  getDb: vi.fn(() => ({ prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })) })),
  getActionItem: vi.fn((id: string) => cards.get(id)),
  updateActionItemFields: vi.fn((id: string, fields: Record<string, unknown>) => { updated.push({ id, fields }); return 1 }),
}))

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('./config.js', () => ({
  ALLOWED_CHAT_ID: '123456789',
  BOT_API_TOKEN: '', DASHBOARD_API_TOKEN: '', DASHBOARD_URL: '',
}))

import { getActionPolicy, DEFAULT_ACTION_POLICY, policyFor, writeAudit } from './policy.js'

describe('getActionPolicy', () => {
  beforeEach(() => knobs.clear())

  it('defaults code.merge to ask, so merging never rides along with code.pr', () => {
    expect(policyFor('pawdev', 'code.merge')).toBe('ask')
    expect(policyFor('pawdev', 'code.pr')).toBe('auto')
  })

  it('returns the spec defaults when the knob is unset', () => {
    expect(getActionPolicy('default')).toEqual(DEFAULT_ACTION_POLICY)
    expect(getActionPolicy('default')['code.pr']).toBe('auto')
    expect(getActionPolicy('default')['email.send']).toBe('ask')
  })

  it('merges the knob over the defaults and ignores unknown values', () => {
    knobs.set('trader:action_policy', '{"email.send":"never","social.post":"bogus"}')
    const p = getActionPolicy('trader')
    expect(p['email.send']).toBe('never')
    expect(p['social.post']).toBe('ask')
    expect(p['code.pr']).toBe('auto')
  })

  it('falls back to the defaults on malformed JSON', () => {
    knobs.set('example-company:action_policy', 'not json')
    expect(getActionPolicy('example-company')).toEqual(DEFAULT_ACTION_POLICY)
  })

  it('treats an unknown action class as ask', () => {
    expect(getActionPolicy('default')['dns.change' as string] ?? 'ask').toBe('ask')
  })
})

describe('writeAudit', () => {
  it('writes one row per outcome with a payload hash', async () => {
    const run = vi.fn(() => ({ lastInsertRowid: 7 }))
    const dbMod = await import('./db.js')
    ;(dbMod.getDb as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      prepare: vi.fn(() => ({ run })),
    })

    const id = writeAudit({
      ts_ms: 1_700_000_000_000,
      project_id: 'default',
      actor: 'social-cli',
      action_class: 'social.post',
      decision: 'deny',
      policy_value: 'never',
      ref_table: null,
      ref_id: null,
      payload_hash: null,
    })

    expect(id).toBe(7)
    expect(run).toHaveBeenCalledTimes(1)
    const args = run.mock.calls[0]
    expect(args).toContain('social.post')
    expect(args).toContain('deny')
  })
})

import { checkAction, setPolicySender } from './policy.js'

const created: Array<Record<string, unknown>> = []
vi.mock('./action-items.js', () => ({
  createActionItem: vi.fn((input: Record<string, unknown>) => {
    created.push(input)
    return 'card-1'
  }),
}))

describe('checkAction', () => {
  beforeEach(() => {
    knobs.clear()
    created.length = 0
    setPolicySender(null)
  })

  it('allows an auto class and audits it', async () => {
    const decision = await checkAction('default', 'code.pr', 'builder', { branch: 'x' })
    expect(decision).toBe('allow')
    expect(created).toHaveLength(0)
  })

  it('denies a never class, opens no card, and audits it', async () => {
    knobs.set('default:action_policy', '{"email.send":"never"}')
    const decision = await checkAction('default', 'email.send', 'broker-weekly-email', { to: 'x@y.z' })
    expect(decision).toBe('deny')
    expect(created).toHaveLength(0)
  })

  it('parks an ask class as a proposed card and sends the act: keyboard', async () => {
    const sent: Array<{ projectId: string; text: string; keyboard: unknown }> = []
    setPolicySender(async (projectId, _chatId, text, keyboard) => { sent.push({ projectId, text, keyboard }) })

    const decision = await checkAction('default', 'social.post', 'social-cli', { platform: 'linkedin' })

    expect(decision).toBe('pending:card-1')
    expect(created).toHaveLength(1)
    expect(created[0].source).toBe('social.post')
    expect(created[0].initial_status).toBe('proposed')
    expect(created[0].executable_by_agent).toBe(true)
    expect(sent).toHaveLength(1)
    expect(JSON.stringify(sent[0].keyboard)).toContain('act:approve:card-1')
    expect(JSON.stringify(sent[0].keyboard)).toContain('act:deny:card-1')
    expect(sent[0].text).not.toMatch(/[<>*_`]/)
  })

  it('sends the card to its own project, not always default', async () => {
    const sent: Array<{ projectId: string }> = []
    setPolicySender(async (projectId) => { sent.push({ projectId }) })

    await checkAction('example-company', 'social.post', 'social-cli', { platform: 'linkedin' })

    expect(sent).toHaveLength(1)
    expect(sent[0].projectId).toBe('example-company')
  })

  it('treats an unknown class as ask', async () => {
    const decision = await checkAction('default', 'dns.change', 'maintainer', null)
    expect(decision).toBe('pending:card-1')
  })
})

// Final fix B5: before this, a CLI the runner re-invoked hit the same ask gate
// and opened a second card, so every approval tap produced another card and
// never the effect.
describe('checkAction under POLICY_APPROVED_CARD', () => {
  beforeEach(() => {
    knobs.clear(); cards.clear(); created.length = 0
    setPolicySender(null)
    delete process.env.POLICY_APPROVED_CARD
  })
  afterEach(() => { delete process.env.POLICY_APPROVED_CARD })

  it('allows the approved card once, without opening another one', async () => {
    cards.set('approved-card', { id: 'approved-card', status: 'approved', source: 'social.post' })
    process.env.POLICY_APPROVED_CARD = 'approved-card'

    const decision = await checkAction('default', 'social.post', 'social-cli', { post_id: 'p1' })

    expect(decision).toBe('allow')
    expect(created).toHaveLength(0)
  })

  it('allows a card already moved to in_progress by the runner', async () => {
    cards.set('approved-card', { id: 'approved-card', status: 'in_progress', source: 'social.post' })
    process.env.POLICY_APPROVED_CARD = 'approved-card'

    expect(await checkAction('default', 'social.post', 'social-cli', {})).toBe('allow')
  })

  it('opens a card when the action class does not match the approved one', async () => {
    cards.set('approved-card', { id: 'approved-card', status: 'approved', source: 'social.post' })
    process.env.POLICY_APPROVED_CARD = 'approved-card'

    const decision = await checkAction('default', 'email.send', 'email-send-cli', {})

    expect(decision).toBe('pending:card-1')
    expect(created).toHaveLength(1)
  })

  it('opens a card when the named card is not approved', async () => {
    cards.set('approved-card', { id: 'approved-card', status: 'proposed', source: 'social.post' })
    process.env.POLICY_APPROVED_CARD = 'approved-card'

    expect(await checkAction('default', 'social.post', 'social-cli', {})).toBe('pending:card-1')
  })
})

// Final fix: the card description is an editable row, so the argv the runner
// executes has to be signed at the point the CLI is known to be genuine.
describe('checkAction signs the replay it records', () => {
  beforeEach(() => {
    knobs.clear(); cards.clear(); created.length = 0; updated.length = 0
    signingAvailable = true
    setPolicySender(null)
    delete process.env.POLICY_APPROVED_CARD
  })

  const replayPayload = { post_id: 'p1', replay: { argv: ['dist/social-cli.js', 'publish', 'p1'], cwd: '/repo' } }

  it('rewrites the description with a signature bound to the new card id', async () => {
    await checkAction('default', 'social.post', 'social-cli', replayPayload)

    expect(updated).toHaveLength(1)
    const stored = JSON.parse(String(updated[0].fields.description)) as {
      payload: { replay: { argv: string[]; cwd: string; sig: string } }
    }
    expect(stored.payload.replay.sig).toBe('sig-for-card-1')
    expect(stored.payload.replay.argv).toEqual(['dist/social-cli.js', 'publish', 'p1'])
    expect(stored.payload.replay.cwd).toBe('/repo')
  })

  it('drops the replay and says why when no signing key is configured', async () => {
    signingAvailable = false

    await checkAction('default', 'social.post', 'social-cli', replayPayload)

    const stored = JSON.parse(String(updated[0].fields.description)) as {
      payload: { replay?: unknown; replay_refused?: string }
    }
    expect(stored.payload.replay).toBeUndefined()
    expect(stored.payload.replay_refused).toContain('no signing key configured')
  })

  it('leaves a card with no replay alone', async () => {
    await checkAction('default', 'social.post', 'social-cli', { post_id: 'p1' })
    expect(updated).toHaveLength(0)
  })
})
