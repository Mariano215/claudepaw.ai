// One test per gated entry point. These prove the gate is called with the
// right class and that a non-allow decision stops the effect. The effect
// itself is mocked; this is about the gate, not the sender.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const decisions = new Map<string, string>()
const calls: Array<{ project: string; cls: string; actor: string; payload: unknown }> = []

vi.mock('./policy.js', () => ({
  checkAction: vi.fn(async (project: string, cls: string, actor: string, payload: unknown) => {
    calls.push({ project, cls, actor, payload })
    return decisions.get(cls) ?? 'allow'
  }),
}))

vi.mock('./logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { gateEmailSend, gateScheduleChange } from './policy-gates.js'

describe('policy gates at the side-effect entry points', () => {
  beforeEach(() => { decisions.clear(); calls.length = 0 })

  it('email.send: never refuses, no mail is sent, and the caller can tell it was a refusal', async () => {
    decisions.set('email.send', 'deny')
    const send = vi.fn(async () => ({ success: true }))
    const res = await gateEmailSend('broker', { to: 'a@b.c', subject: 's' }, send)
    expect(res.kind).toBe('denied')
    expect(send).not.toHaveBeenCalled()
  })

  it('email.send: ask parks, no mail is sent, and the caller can tell it was parked (not a send failure)', async () => {
    decisions.set('email.send', 'pending:card-3')
    const send = vi.fn(async () => ({ success: true }))
    const res = await gateEmailSend('broker', { to: 'a@b.c', subject: 's' }, send)
    expect(res.kind).toBe('parked')
    expect(res.kind === 'parked' && res.cardId).toBe('card-3')
    expect(send).not.toHaveBeenCalled()
  })

  it('email.send: auto sends and the caller gets the send result', async () => {
    const send = vi.fn(async () => ({ success: true, messageId: 'm1' }))
    const res = await gateEmailSend('broker', { to: 'a@b.c', subject: 's' }, send)
    expect(res.kind).toBe('allow')
    expect(res.kind === 'allow' && res.result.messageId).toBe('m1')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('schedule.change: never refuses the mutation', async () => {
    decisions.set('schedule.change', 'deny')
    const mutate = vi.fn()
    const ok = await gateScheduleChange('default', 'create', 'daily-backup', mutate)
    expect(ok).toBe(false)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('schedule.change: ask parks the mutation', async () => {
    decisions.set('schedule.change', 'pending:card-4')
    const mutate = vi.fn()
    const ok = await gateScheduleChange('default', 'pause', 'daily-backup', mutate)
    expect(ok).toBe(false)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('schedule.change: auto runs the mutation', async () => {
    const mutate = vi.fn()
    const ok = await gateScheduleChange('default', 'delete', 'daily-backup', mutate)
    expect(ok).toBe(true)
    expect(mutate).toHaveBeenCalledTimes(1)
  })
})

// Final fix B5: without a replayable command on the card, an approval tap
// gives the runner a JSON blob and the effect never happens.
describe('every CLI gate records a replayable command', () => {
  beforeEach(() => { decisions.clear(); calls.length = 0 })

  it('puts argv and cwd in the payload for each gate', async () => {
    await gateEmailSend('default', { to: 'a@b.c', subject: 's' }, async () => 'sent')
    await gateScheduleChange('default', 'delete', 'task-1', () => {})

    expect(calls).toHaveLength(2)
    for (const call of calls) {
      const replay = (call.payload as { replay?: { argv?: unknown; cwd?: unknown } }).replay
      expect(Array.isArray(replay?.argv)).toBe(true)
      expect(replay?.argv).toEqual(process.argv.slice(1))
      expect(replay?.cwd).toBe(process.cwd())
    }
  })
})
