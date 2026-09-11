import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ChannelManager } from './manager.js'
import * as killSwitch from '../cost/kill-switch-client.js'
import * as db from '../db.js'

// This file tests the kill-switch gate only, not the digest/quiet-hours
// hold decision. Force shouldHold false so routine text always reaches
// the channel and the assertions below stay about the kill switch.
vi.mock('./quiet-hours.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quiet-hours.js')>()
  return { ...actual, shouldHold: () => false }
})

function makeChannel(id = 'telegram') {
  return {
    id,
    name: 'test',
    capabilities: () => ({
      maxMessageLength: 4096,
      voice: true,
      media: false,
      typing: false,
      formatting: 'plain' as const,
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(true),
    send: vi.fn().mockResolvedValue(undefined),
    sendVoice: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    sendWithKeyboard: vi.fn().mockResolvedValue(undefined),
  }
}

describe('ChannelManager kill-switch gate', () => {
  beforeEach(() => vi.restoreAllMocks())

  // ── send() ──────────────────────────────────────────────────────────

  it('does not send when kill switch is tripped', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({ set_at: 1, reason: 'over budget' })
    const mgr = new ChannelManager()
    const channel = makeChannel()
    mgr.register(channel)
    await mgr.startAll()
    await mgr.send('telegram', '123', 'hi')
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('sends normally when kill switch is clear', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue(null)
    const mgr = new ChannelManager()
    const channel = makeChannel()
    mgr.register(channel)
    await mgr.startAll()
    await mgr.send('telegram', '123', 'hi')
    expect(channel.send).toHaveBeenCalled()
  })

  // ── sendWithKeyboard() ──────────────────────────────────────────────

  it('does not sendWithKeyboard when kill switch is tripped', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({ set_at: 1, reason: 'over budget' })
    const mgr = new ChannelManager()
    const channel = makeChannel()
    mgr.register(channel)
    await mgr.startAll()
    await mgr.sendWithKeyboard('telegram', '123', 'hi', { inline_keyboard: [] })
    expect(channel.sendWithKeyboard).not.toHaveBeenCalled()
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('sends with keyboard normally when kill switch is clear', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue(null)
    const mgr = new ChannelManager()
    const channel = makeChannel()
    mgr.register(channel)
    await mgr.startAll()
    await mgr.sendWithKeyboard('telegram', '123', 'hi', { inline_keyboard: [] })
    expect(channel.sendWithKeyboard).toHaveBeenCalled()
  })

  // Approval cards used to reach Telegram through the raw channel, so they
  // never got a channel_log row and no approval request was auditable.
  it('writes a channel_log row for a keyboard send', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue(null)
    const logSpy = vi.spyOn(db, 'logChannelMessage').mockImplementation(() => undefined as never)
    const mgr = new ChannelManager()
    const channel = makeChannel()
    mgr.register(channel)
    await mgr.startAll()
    await mgr.sendWithKeyboard('telegram', '123', 'approve this?', { inline_keyboard: [] })
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'out', channel: 'telegram', chatId: '123', content: 'approve this?' }),
    )
  })

  // ── sendVoice() ─────────────────────────────────────────────────────

  it('does not sendVoice when kill switch is tripped', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({ set_at: 1, reason: 'over budget' })
    const mgr = new ChannelManager()
    const channel = makeChannel()
    mgr.register(channel)
    await mgr.startAll()
    await mgr.sendVoice('telegram', '123', Buffer.from('audio'), 'fallback text')
    expect(channel.sendVoice).not.toHaveBeenCalled()
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('sends voice normally when kill switch is clear', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue(null)
    const mgr = new ChannelManager()
    const channel = makeChannel()
    mgr.register(channel)
    await mgr.startAll()
    await mgr.sendVoice('telegram', '123', Buffer.from('audio'), 'fallback text')
    expect(channel.sendVoice).toHaveBeenCalled()
  })

})
