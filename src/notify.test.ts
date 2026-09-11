import { describe, it, expect, vi, beforeEach } from 'vitest'

const held: Array<{ channelId: string; chatId: string; text: string; projectId?: string }> = []

vi.mock('./channels/quiet-hours.js', () => ({
  holdMessage: vi.fn((channelId: string, chatId: string, text: string, projectId?: string) => {
    held.push({ channelId, chatId, text, projectId })
  }),
}))
vi.mock('./config.js', () => ({ ALLOWED_CHAT_ID: '123456789' }))
vi.mock('./logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { notifyOwner, setOutboundSender } from './notify.js'

describe('notifyOwner', () => {
  beforeEach(() => { held.length = 0; setOutboundSender(null) })

  it('uses the registered ChannelManager sender when the bot is running', async () => {
    const sent: string[] = []
    setOutboundSender(async (_c, _chat, text) => { sent.push(text) })
    await notifyOwner('Rentcast at 80 percent of the monthly cap', 'broker')
    expect(sent).toEqual(['Rentcast at 80 percent of the monthly cap'])
    expect(held).toHaveLength(0)
  })

  it('falls back to the routine buffer in a CLI process', async () => {
    await notifyOwner('Rentcast at 80 percent of the monthly cap', 'broker')
    expect(held).toHaveLength(1)
    expect(held[0].projectId).toBe('broker')
  })

  it('never throws when the sender fails', async () => {
    setOutboundSender(async () => { throw new Error('telegram down') })
    await expect(notifyOwner('x')).resolves.toBeUndefined()
    expect(held).toHaveLength(1)
  })
})
