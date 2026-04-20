import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ChannelManager } from './manager.js'
import * as killSwitch from '../cost/kill-switch-client.js'

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
