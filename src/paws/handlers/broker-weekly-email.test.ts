// A gate refusal (denied or parked) must not fall back to the Telegram
// notice reserved for a real send failure. This proves both branches of
// gateEmailSend's discriminated result stop the handler before notifyOwner.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const notifyCalls: string[] = []
vi.mock('../../notify.js', () => ({
  notifyOwner: vi.fn(async (text: string) => { notifyCalls.push(text) }),
}))

vi.mock('../../logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const sendEmail = vi.fn(async (_msg: unknown) => ({ success: true, messageId: 'm1' }))
vi.mock('../../google/gmail.js', () => ({ sendEmail: (msg: unknown) => sendEmail(msg) }))

let gateResult: { kind: 'allow'; result: { success: boolean; messageId?: string; error?: string } } | { kind: 'parked'; cardId: string | null } | { kind: 'denied' }
vi.mock('../../policy-gates.js', () => ({
  gateEmailSend: vi.fn(async () => gateResult),
}))

const actOutput = JSON.stringify({
  actions: [{ type: 'send_email', subject: 'Weekly deals', html_body: '<p>hi</p>' }],
})

describe('brokerWeeklyEmailHandler: gate refusal never falls back to Telegram', () => {
  beforeEach(() => { notifyCalls.length = 0; sendEmail.mockClear() })

  it('denied: no send, no Telegram fallback', async () => {
    gateResult = { kind: 'denied' }
    const { brokerWeeklyEmailHandler } = await import('./broker-weekly-email.js')
    await brokerWeeklyEmailHandler('c1', 'p1', 'broker', actOutput)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(notifyCalls).toHaveLength(0)
  })

  it('parked: no send, no Telegram fallback', async () => {
    gateResult = { kind: 'parked', cardId: 'card-1' }
    const { brokerWeeklyEmailHandler } = await import('./broker-weekly-email.js')
    await brokerWeeklyEmailHandler('c2', 'p1', 'broker', actOutput)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(notifyCalls).toHaveLength(0)
  })

  it('allow: sends and pings Telegram on success', async () => {
    gateResult = { kind: 'allow', result: { success: true, messageId: 'm1' } }
    const { brokerWeeklyEmailHandler } = await import('./broker-weekly-email.js')
    await brokerWeeklyEmailHandler('c3', 'p1', 'broker', actOutput)
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0]).toContain('Broker weekly digest sent')
  })
})
