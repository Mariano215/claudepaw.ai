import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Row { id: string; project_id: string; title: string; description: string | null; status: string; executable_by_agent: 0 | 1; created_at: number; updated_at: number }
const rows: Row[] = []
const transitions: Array<{ id: string; to: string }> = []
const fields: Array<{ id: string; f: Record<string, unknown> }> = []

vi.mock('./db.js', () => ({
  listActionItems: vi.fn((opts: { status?: string }) =>
    rows.filter(r => (opts.status ? r.status === opts.status : true))),
  updateActionItemFields: vi.fn((id: string, f: Record<string, unknown>) => { fields.push({ id, f }); return 1 }),
}))

vi.mock('./action-items.js', () => ({
  transitionActionItem: vi.fn((id: string, to: string) => {
    transitions.push({ id, to })
    const r = rows.find(x => x.id === id)
    if (r) r.status = to
  }),
}))

vi.mock('./logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('./telemetry.js', () => ({ recordError: vi.fn() }))

// The signature itself is covered in replay-signing.test.ts. Here the verdict
// is controlled so the runner's branching is what is under test.
let signatureOk = true
vi.mock('./replay-signing.js', () => ({
  verifyReplaySignature: vi.fn(() => signatureOk),
}))

import { PROJECT_ROOT } from './config.js'
import { recordError } from './telemetry.js'
import { runApprovedCards, triageStaleCards, type RunAgentFn, type RunReplayFn } from './card-runner.js'

function card(over: Partial<Row> = {}): Row {
  return { id: 'c1', project_id: 'default', title: 'Do the thing', description: '{"action_class":"social.post"}',
    status: 'approved', executable_by_agent: 1, created_at: Date.now(), updated_at: Date.now(), ...over }
}

describe('runApprovedCards', () => {
  beforeEach(() => { rows.length = 0; transitions.length = 0; fields.length = 0 })

  it('runs an approved executable card and completes it', async () => {
    rows.push(card())
    const run = vi.fn<RunAgentFn>(async () => ({ text: 'DONE: posted' }))

    const out = await runApprovedCards(run)

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toContain('Do the thing')
    expect(transitions).toEqual([{ id: 'c1', to: 'in_progress' }, { id: 'c1', to: 'completed' }])
    expect(out).toEqual({ started: 1, completed: 1, blocked: 0 })
  })

  it('blocks a card when the agent returns nothing', async () => {
    rows.push(card())
    const out = await runApprovedCards(async () => ({ text: null }))
    expect(transitions).toEqual([{ id: 'c1', to: 'in_progress' }, { id: 'c1', to: 'blocked' }])
    expect(out.blocked).toBe(1)
  })

  it('blocks a card when the agent throws', async () => {
    rows.push(card())
    const out = await runApprovedCards(async () => { throw new Error('boom') })
    expect(transitions[1]).toEqual({ id: 'c1', to: 'blocked' })
    expect(out.blocked).toBe(1)
    expect(String(fields.at(-1)?.f.last_run_result)).toContain('boom')
  })

  it('skips cards that are not executable by an agent', async () => {
    rows.push(card({ executable_by_agent: 0 }))
    const run = vi.fn(async () => ({ text: 'DONE: x' }))
    const out = await runApprovedCards(run)
    expect(run).not.toHaveBeenCalled()
    expect(out.started).toBe(0)
  })

  it('runs at most one card per project per tick', async () => {
    rows.push(card({ id: 'a' }), card({ id: 'b' }), card({ id: 'c', project_id: 'trader' }))
    const run = vi.fn(async () => ({ text: 'DONE: ok' }))
    await runApprovedCards(run)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('reaps an in_progress card stuck since before a crash or restart', async () => {
    rows.push(card({ id: 'stuck', status: 'in_progress', updated_at: Date.now() - 3 * 60 * 60 * 1000 }))
    const run = vi.fn(async () => ({ text: 'DONE: ok' }))

    const out = await runApprovedCards(run)

    expect(transitions).toEqual([{ id: 'stuck', to: 'blocked' }])
    expect(fields.at(-1)).toEqual({ id: 'stuck', f: { last_run_result: 'runner did not finish (restart)' } })
    expect(run).not.toHaveBeenCalled()
    expect(out.started).toBe(0)
  })

  it('leaves a fresh in_progress card alone', async () => {
    rows.push(card({ id: 'fresh', status: 'in_progress', updated_at: Date.now() }))
    const run = vi.fn(async () => ({ text: 'DONE: ok' }))

    await runApprovedCards(run)

    expect(transitions).toEqual([])
    expect(fields).toEqual([])
  })
})

// Final fix B6: any non-empty reply used to count as success, so a card the
// runner cannot do at all shipped as completed on a polite refusal.
describe('the agent must say DONE', () => {
  beforeEach(() => { rows.length = 0; transitions.length = 0; fields.length = 0 })

  it('completes only when the reply carries a DONE line', async () => {
    rows.push(card())
    const out = await runApprovedCards(async () => ({ text: 'Ran it.\nDONE: posted the update' }))
    expect(transitions).toEqual([{ id: 'c1', to: 'in_progress' }, { id: 'c1', to: 'completed' }])
    expect(out.completed).toBe(1)
  })

  it('blocks a reply with no marker and records the first 200 characters', async () => {
    rows.push(card())
    const refusal = 'I cannot edit files in this session, the Write tool is not available. '.repeat(6)
    const out = await runApprovedCards(async () => ({ text: refusal }))
    expect(transitions).toEqual([{ id: 'c1', to: 'in_progress' }, { id: 'c1', to: 'blocked' }])
    expect(out.blocked).toBe(1)
    expect(String(fields.at(-1)?.f.last_run_result)).toHaveLength(200)
  })

  it('blocks a BLOCKED reply', async () => {
    rows.push(card())
    const out = await runApprovedCards(async () => ({ text: 'BLOCKED: no credentials' }))
    expect(transitions[1]).toEqual({ id: 'c1', to: 'blocked' })
    expect(out.blocked).toBe(1)
  })
})

// Final fix B5: a card carrying a replay runs the recorded command instead of
// handing an agent a JSON blob it cannot act on.
describe('replayable cards', () => {
  beforeEach(() => { rows.length = 0; transitions.length = 0; fields.length = 0; signatureOk = true })

  const replayCard = (argv = ['dist/social-cli.js', 'publish', 'p1'], cwd = PROJECT_ROOT) => card({
    description: JSON.stringify({
      class: 'social.post',
      actor: 'social-cli',
      payload: { post_id: 'p1', replay: { argv, cwd, sig: 'a'.repeat(64) } },
    }),
  })

  it('re-runs the recorded argv with the approved card id in the env', async () => {
    rows.push(replayCard())
    const agent = vi.fn<RunAgentFn>(async () => ({ text: 'DONE: x' }))
    const replay = vi.fn<RunReplayFn>(async () => ({ code: 0, stdout: 'queued p1', stderr: '' }))

    const out = await runApprovedCards(agent, replay)

    expect(agent).not.toHaveBeenCalled()
    expect(replay).toHaveBeenCalledTimes(1)
    expect(replay.mock.calls[0][0]).toEqual(['dist/social-cli.js', 'publish', 'p1'])
    expect(replay.mock.calls[0][1].cwd).toBe(PROJECT_ROOT)
    expect(replay.mock.calls[0][1].env.POLICY_APPROVED_CARD).toBe('c1')
    expect(transitions).toEqual([{ id: 'c1', to: 'in_progress' }, { id: 'c1', to: 'completed' }])
    expect(out).toEqual({ started: 1, completed: 1, blocked: 0 })
  })

  it('blocks on a non-zero exit and keeps the tail of stderr', async () => {
    rows.push(replayCard())
    const replay = vi.fn<RunReplayFn>(async () => ({ code: 2, stdout: '', stderr: 'auth failed' }))

    const out = await runApprovedCards(undefined, replay)

    expect(transitions[1]).toEqual({ id: 'c1', to: 'blocked' })
    expect(out.blocked).toBe(1)
    expect(fields.at(-1)?.f.last_run_result).toBe('auth failed')
  })

  // The description is an editable row, so an argv that does not verify must
  // never reach exec.
  it('blocks a tampered argv instead of running it', async () => {
    rows.push(replayCard(['dist/social-cli.js', 'publish', 'someone-elses-post']))
    signatureOk = false
    const replay = vi.fn<RunReplayFn>(async () => ({ code: 0, stdout: '', stderr: '' }))

    const out = await runApprovedCards(undefined, replay)

    expect(replay).not.toHaveBeenCalled()
    expect(transitions[1]).toEqual({ id: 'c1', to: 'blocked' })
    expect(fields.at(-1)?.f.last_run_result).toBe('replay signature invalid')
    expect(recordError).toHaveBeenCalled()
    expect(out.blocked).toBe(1)
  })

  it('blocks an argv whose first token is not a known CLI', async () => {
    rows.push(replayCard(['dist/evil.js', 'go']))
    const replay = vi.fn<RunReplayFn>(async () => ({ code: 0, stdout: '', stderr: '' }))

    const out = await runApprovedCards(undefined, replay)

    expect(replay).not.toHaveBeenCalled()
    expect(fields.at(-1)?.f.last_run_result).toBe('replay argv does not name a known CLI')
    expect(out.blocked).toBe(1)
  })

  it('blocks an argv carrying a control character', async () => {
    rows.push(replayCard(['dist/social-cli.js', 'publish\nrm -rf /']))
    const replay = vi.fn<RunReplayFn>(async () => ({ code: 0, stdout: '', stderr: '' }))

    await runApprovedCards(undefined, replay)

    expect(replay).not.toHaveBeenCalled()
    expect(fields.at(-1)?.f.last_run_result).toBe('replay argv contains a control character')
  })

  it('blocks a recorded cwd that is not the repo root', async () => {
    rows.push(replayCard(['dist/social-cli.js', 'publish', 'p1'], '/somewhere/else'))
    const replay = vi.fn<RunReplayFn>(async () => ({ code: 0, stdout: '', stderr: '' }))

    await runApprovedCards(undefined, replay)

    expect(replay).not.toHaveBeenCalled()
    expect(fields.at(-1)?.f.last_run_result).toBe('replay cwd not allowed')
  })

  it('blocks an argv carrying a node eval flag', async () => {
    for (const flag of ['-e', '--eval', '--import', '-r', '--require', '--loader']) {
      rows.length = 0; transitions.length = 0; fields.length = 0
      rows.push(replayCard(['dist/social-cli.js', flag, 'console.log(1)']))
      const replay = vi.fn<RunReplayFn>(async () => ({ code: 0, stdout: '', stderr: '' }))

      await runApprovedCards(undefined, replay)

      expect(replay).not.toHaveBeenCalled()
      expect(fields.at(-1)?.f.last_run_result).toBe('replay argv contains a node eval flag')
    }
  })

  it('blocks an argv whose first token is a flag', async () => {
    rows.push(replayCard(['--eval', 'x']))
    const replay = vi.fn<RunReplayFn>(async () => ({ code: 0, stdout: '', stderr: '' }))
    await runApprovedCards(undefined, replay)
    expect(replay).not.toHaveBeenCalled()
  })

  // The child gets the filtered agent env, not the bot's own, so a CLI cannot
  // read the bot's tokens out of its environment.
  it('passes the filtered agent env, without the bot secrets', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'not-a-real-token'
    try {
      rows.push(replayCard())
      const replay = vi.fn<RunReplayFn>(async () => ({ code: 0, stdout: 'ok', stderr: '' }))

      await runApprovedCards(undefined, replay)

      const env = replay.mock.calls[0][1].env
      expect(env.POLICY_APPROVED_CARD).toBe('c1')
      expect('TELEGRAM_BOT_TOKEN' in env).toBe(false)
      expect('DASHBOARD_API_TOKEN' in env).toBe(false)
      expect(env.PATH).toBeTruthy()
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN
    }
  })

  it('falls back to the agent when the card has no replay', async () => {
    rows.push(card())
    const agent = vi.fn<RunAgentFn>(async () => ({ text: 'DONE: x' }))
    const replay = vi.fn<RunReplayFn>(async () => ({ code: 0, stdout: '', stderr: '' }))

    await runApprovedCards(agent, replay)

    expect(replay).not.toHaveBeenCalled()
    expect(agent).toHaveBeenCalledTimes(1)
  })
})

describe('triageStaleCards', () => {
  beforeEach(() => { rows.length = 0; transitions.length = 0 })

  it('rejects proposed cards older than the window and leaves fresh ones', () => {
    const old = Date.now() - 61 * 86_400_000
    rows.push(card({ id: 'old', status: 'proposed', created_at: old }))
    rows.push(card({ id: 'new', status: 'proposed', created_at: Date.now() }))

    const n = triageStaleCards(60 * 86_400_000)

    expect(n).toBe(1)
    expect(transitions).toEqual([{ id: 'old', to: 'rejected' }])
  })
})

describe('pawdev cards', () => {
  beforeEach(() => { rows.length = 0; transitions.length = 0; fields.length = 0 })

  it('leaves a pawdev card alone and runs the default one', async () => {
    rows.push(card({ id: 'pd1', project_id: 'pawdev', description: 'effort trivial' }))
    rows.push(card({ id: 'd1', project_id: 'default' }))
    const run = vi.fn<RunAgentFn>(async () => ({ text: 'DONE: posted' }))

    const out = await runApprovedCards(run)

    expect(run).toHaveBeenCalledTimes(1)
    expect(transitions.map(t => t.id)).toEqual(['d1', 'd1'])
    expect(out).toEqual({ started: 1, completed: 1, blocked: 0 })
    expect(rows.find(r => r.id === 'pd1')!.status).toBe('approved')
  })
})
