// ---------------------------------------------------------------------------
// ChannelManager -- orchestrates all messaging channels
// ---------------------------------------------------------------------------

import type { Channel } from './types.js'
import { getFormatter, splitMessage } from './formatters.js'
import { logger } from '../logger.js'

export class ChannelManager {
  private channels = new Map<string, Channel>()
  private running = new Map<string, Channel>()

  /**
   * Register a channel. Call before startAll().
   */
  register(channel: Channel): void {
    if (this.channels.has(channel.id)) {
      logger.warn({ channelId: channel.id }, 'Channel already registered, replacing')
    }
    this.channels.set(channel.id, channel)
    logger.info({ channelId: channel.id, name: channel.name }, 'Channel registered')
  }

  /**
   * Start all registered channels. Failures are logged and skipped.
   */
  async startAll(): Promise<void> {
    const results: { id: string; ok: boolean; error?: string }[] = []

    for (const [id, channel] of this.channels) {
      try {
        await channel.start()
        this.running.set(id, channel)
        results.push({ id, ok: true })
        logger.info({ channelId: id }, 'Channel started')
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        results.push({ id, ok: false, error: errMsg })
        logger.error({ channelId: id, err }, 'Channel failed to start')
      }
    }

    const ok = results.filter((r) => r.ok).length
    const failed = results.filter((r) => !r.ok).length
    logger.info({ ok, failed, total: results.length }, 'Channel startup complete')

    if (ok === 0 && this.channels.size > 0) {
      logger.warn('No channels started successfully')
    }
  }

  /**
   * Gracefully stop all running channels.
   */
  async stopAll(): Promise<void> {
    for (const [id, channel] of this.running) {
      try {
        await channel.stop()
        logger.info({ channelId: id }, 'Channel stopped')
      } catch (err) {
        logger.error({ channelId: id, err }, 'Channel failed to stop cleanly')
      }
    }
    this.running.clear()
  }

  /**
   * Get a channel by ID.
   */
  getChannel(id: string): Channel | undefined {
    return this.running.get(id)
  }

  /**
   * Send a message with inline keyboard buttons through a Telegram channel.
   * No-ops if the channel isn't Telegram or isn't running.
   */
  async sendWithKeyboard(
    channelId: string,
    chatId: string,
    text: string,
    keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
  ): Promise<void> {
    const { checkKillSwitch } = await import('../cost/kill-switch-client.js')
    const sw = await checkKillSwitch()
    if (sw) {
      logger.warn({ channelId, chatId, reason: sw.reason }, 'send blocked by kill switch')
      return
    }
    const channel = this.running.get(channelId) as any
    if (!channel || typeof channel.sendWithKeyboard !== 'function') {
      await this.send(channelId, chatId, text)
      return
    }
    try {
      await channel.sendWithKeyboard(chatId, text, keyboard)
    } catch (err) {
      logger.error({ channelId, chatId, err }, 'Failed to send with keyboard, falling back to text')
      await this.send(channelId, chatId, text)
    }
  }

  /**
   * Get all running channels.
   */
  getRunningChannels(): Channel[] {
    return Array.from(this.running.values())
  }

  /**
   * Send a text message through the specified channel.
   * Handles formatting and chunking automatically.
   */
  async send(channelId: string, chatId: string, text: string): Promise<void> {
    const { checkKillSwitch } = await import('../cost/kill-switch-client.js')
    const sw = await checkKillSwitch()
    if (sw) {
      logger.warn({ channelId, chatId, reason: sw.reason }, 'send blocked by kill switch')
      return
    }
    const channel = this.running.get(channelId)
    if (!channel) {
      logger.error({ channelId, chatId }, 'Cannot send -- channel not running')
      return
    }

    try {
      const formatter = getFormatter(channelId)
      const formatted = formatter(text)
      const chunks = splitMessage(formatted, channel.capabilities().maxMessageLength)
      for (const chunk of chunks) {
        await channel.send(chatId, chunk)
      }
    } catch (err) {
      logger.error({ channelId, chatId, err }, 'Failed to send message')
    }
  }

  /**
   * Send a voice message through the specified channel.
   */
  async sendVoice(
    channelId: string,
    chatId: string,
    audio: Buffer,
    text?: string,
  ): Promise<void> {
    const { checkKillSwitch } = await import('../cost/kill-switch-client.js')
    const sw = await checkKillSwitch()
    if (sw) {
      logger.warn({ channelId, chatId, reason: sw.reason }, 'send blocked by kill switch')
      return
    }
    const channel = this.running.get(channelId)
    if (!channel) {
      logger.error({ channelId, chatId }, 'Cannot send voice -- channel not running')
      return
    }

    if (!channel.capabilities().voice) {
      // Fallback to text if channel doesn't support voice
      if (text) {
        await this.send(channelId, chatId, text)
      }
      return
    }

    try {
      await channel.sendVoice(chatId, audio, text)
    } catch (err) {
      logger.error({ channelId, chatId, err }, 'Failed to send voice, falling back to text')
      if (text) {
        await this.send(channelId, chatId, text)
      }
    }
  }

  /**
   * Find the best channel for a project.
   * Prefers project-specific telegram channel, falls back to main 'telegram'.
   */
  getChannelForProject(projectId: string): string {
    const projectChannelId = `telegram:${projectId}`
    if (this.running.has(projectChannelId)) return projectChannelId
    if (this.running.has('telegram')) return 'telegram'
    const first = this.running.keys().next().value
    return first ?? 'telegram'
  }

  /**
   * Send a message to all running channels (for system notifications).
   */
  async broadcast(chatIds: Record<string, string>, text: string): Promise<void> {
    for (const [channelId, chatId] of Object.entries(chatIds)) {
      await this.send(channelId, chatId, text)
    }
  }
}
