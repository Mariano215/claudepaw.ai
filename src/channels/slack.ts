// ---------------------------------------------------------------------------
// Slack channel
//
// Uses @slack/bolt in Socket Mode (no public URL needed).
// Listens for DMs and app mentions.
// ---------------------------------------------------------------------------

import { App } from '@slack/bolt'
import type {
  Channel,
  ChannelCapabilities,
  IncomingMessage,
  OnMessageCallback,
  SendOptions,
} from './types.js'
import { formatForSlack, splitMessage } from './formatters.js'
import { handleCommand } from '../pipeline.js'
import { logger } from '../logger.js'

export interface SlackChannelConfig {
  botToken: string
  appToken: string
  allowedUserIds: string[]
}

export class SlackChannel implements Channel {
  readonly id = 'slack'
  readonly name = 'Slack'

  private app: App
  private config: SlackChannelConfig
  private onMessage: OnMessageCallback
  private _running = false

  constructor(config: SlackChannelConfig, onMessage: OnMessageCallback) {
    this.config = config
    this.onMessage = onMessage
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
      logger: {
        debug: (...args: any[]) => logger.debug(args, 'slack'),
        info: (...args: any[]) => logger.info(args, 'slack'),
        warn: (...args: any[]) => logger.warn(args, 'slack'),
        error: (...args: any[]) => logger.error(args, 'slack'),
        getLevel: () => 'info' as any,
        setLevel: () => {},
        setName: () => {},
      } as any,
    })
  }

  // -- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (!this.config.botToken || !this.config.appToken) {
      throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN required')
    }

    this.registerHandlers()
    await this.app.start()
    this._running = true
    logger.info('Slack channel started (Socket Mode)')
  }

  async stop(): Promise<void> {
    this._running = false
    await this.app.stop()
  }

  isRunning(): boolean {
    return this._running
  }

  // -- Outbound -----------------------------------------------------------

  async send(chatId: string, text: string, _opts?: SendOptions): Promise<void> {
    const formatted = formatForSlack(text)
    const chunks = splitMessage(formatted, 4000)

    for (const chunk of chunks) {
      await this.app.client.chat.postMessage({
        channel: chatId,
        text: chunk,
      })
    }
  }

  async sendVoice(chatId: string, audio: Buffer, text?: string): Promise<void> {
    // Upload audio as a file
    try {
      await this.app.client.filesUploadV2({
        channel_id: chatId,
        file: audio,
        filename: 'reply.ogg',
        title: 'Voice reply',
      })
    } catch (err) {
      logger.error({ err }, 'Slack voice file upload failed')
    }

    if (text && text.length > 200) {
      await this.send(chatId, text)
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Slack doesn't have a direct typing indicator API for bots
  }

  // -- Introspection ------------------------------------------------------

  capabilities(): ChannelCapabilities {
    return {
      voice: false, // Can upload files but not true voice
      media: true,
      formatting: 'mrkdwn',
      maxMessageLength: 4000,
      typing: false,
    }
  }

  // -- Internal -----------------------------------------------------------

  private isAllowed(userId: string): boolean {
    if (this.config.allowedUserIds.length === 0) return false
    return this.config.allowedUserIds.includes(userId)
  }

  private registerHandlers(): void {
    // Direct messages
    this.app.message(async ({ message, say }) => {
      // Type guard for regular messages
      if (!('user' in message) || !('text' in message)) return
      if (message.subtype) return // Skip edits, joins, etc.

      const userId = message.user
      if (!userId || !this.isAllowed(userId)) return

      const text = message.text ?? ''
      if (!text.trim()) return

      const channelId = message.channel

      // Check for commands
      if (text.startsWith('/')) {
        const spaceIdx = text.indexOf(' ')
        const command = spaceIdx === -1 ? text.slice(1).toLowerCase() : text.slice(1, spaceIdx).toLowerCase()
        const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1)
        const compositeId = `slack:${channelId}`
        const result = await handleCommand(compositeId, 'slack', channelId, command, args)
        if (result.handled && result.response) {
          const formatted = formatForSlack(result.response)
          const chunks = splitMessage(formatted, 4000)
          for (const chunk of chunks) {
            await say(chunk)
          }
          return
        }
      }

      await this.onMessage({
        channelId: 'slack',
        chatId: channelId,
        text: text.trim(),
        isVoice: false,
        raw: message,
      })
    })

    // App mentions in channels
    this.app.event('app_mention', async ({ event, say }) => {
      const userId = event.user
      if (!userId || !this.isAllowed(userId)) return

      // Strip the bot mention
      let text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim()
      if (!text) return

      const channelId = event.channel

      // Check for commands
      if (text.startsWith('/')) {
        const spaceIdx = text.indexOf(' ')
        const command = spaceIdx === -1 ? text.slice(1).toLowerCase() : text.slice(1, spaceIdx).toLowerCase()
        const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1)
        const compositeId = `slack:${channelId}`
        const result = await handleCommand(compositeId, 'slack', channelId, command, args)
        if (result.handled && result.response) {
          const formatted = formatForSlack(result.response)
          await say(formatted.slice(0, 4000))
          return
        }
      }

      await this.onMessage({
        channelId: 'slack',
        chatId: channelId,
        text,
        isVoice: false,
        raw: event,
      })
    })
  }
}
