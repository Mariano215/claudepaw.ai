// ---------------------------------------------------------------------------
// Discord channel
//
// Uses discord.js. Listens for DMs and mentions. Registers slash commands.
// ---------------------------------------------------------------------------

import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
} from 'discord.js'
import type { Message as DiscordMessage } from 'discord.js'
import type {
  Channel,
  ChannelCapabilities,
  IncomingMessage,
  OnMessageCallback,
  SendOptions,
} from './types.js'
import { formatForDiscord, splitMessage } from './formatters.js'
import { handleCommand } from '../pipeline.js'
import { logger } from '../logger.js'

export interface DiscordChannelConfig {
  botToken: string
  allowedUserIds: string[]
}

export class DiscordChannel implements Channel {
  readonly id = 'discord'
  readonly name = 'Discord'

  private client: Client
  private config: DiscordChannelConfig
  private onMessage: OnMessageCallback
  private _running = false

  constructor(config: DiscordChannelConfig, onMessage: OnMessageCallback) {
    this.config = config
    this.onMessage = onMessage
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    })
  }

  // -- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (!this.config.botToken) {
      throw new Error('DISCORD_BOT_TOKEN not set')
    }

    this.registerHandlers()

    await this.client.login(this.config.botToken)
    this._running = true

    // Register slash commands after login
    await this.registerSlashCommands()

    logger.info('Discord channel started')
  }

  async stop(): Promise<void> {
    this._running = false
    this.client.destroy()
  }

  isRunning(): boolean {
    return this._running
  }

  // -- Outbound -----------------------------------------------------------

  async send(chatId: string, text: string, _opts?: SendOptions): Promise<void> {
    const channel = await this.client.channels.fetch(chatId)
    if (!channel || !('send' in channel)) {
      logger.error({ chatId }, 'Discord channel not found or not sendable')
      return
    }

    const formatted = formatForDiscord(text)
    const chunks = splitMessage(formatted, 2000)
    for (const chunk of chunks) {
      await (channel as any).send(chunk)
    }
  }

  async sendVoice(chatId: string, audio: Buffer, text?: string): Promise<void> {
    const channel = await this.client.channels.fetch(chatId)
    if (!channel || !('send' in channel)) return

    const attachment = new AttachmentBuilder(audio, { name: 'reply.ogg' })
    await (channel as any).send({ files: [attachment] })

    if (text && text.length > 200) {
      await this.send(chatId, text)
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(chatId)
      if (channel && 'sendTyping' in channel) {
        await (channel as any).sendTyping()
      }
    } catch { /* ignore */ }
  }

  // -- Introspection ------------------------------------------------------

  capabilities(): ChannelCapabilities {
    return {
      voice: true,
      media: true,
      formatting: 'markdown',
      maxMessageLength: 2000,
      typing: true,
    }
  }

  // -- Internal -----------------------------------------------------------

  private isAllowed(userId: string): boolean {
    if (this.config.allowedUserIds.length === 0) return false
    return this.config.allowedUserIds.includes(userId)
  }

  private registerHandlers(): void {
    this.client.on('ready', () => {
      logger.info({ user: this.client.user?.tag }, 'Discord bot ready')
    })

    this.client.on('messageCreate', async (msg: DiscordMessage) => {
      // Ignore bot messages
      if (msg.author.bot) return

      // Auth check
      if (!this.isAllowed(msg.author.id)) return

      // Only process DMs or messages that mention the bot
      const isDM = !msg.guild
      const isMention = msg.mentions.has(this.client.user!.id)
      if (!isDM && !isMention) return

      let text = msg.content
      // Strip bot mention from the text
      if (isMention) {
        text = text.replace(/<@!?\d+>/g, '').trim()
      }

      if (!text) return

      // Check for commands
      if (text.startsWith('/')) {
        const spaceIdx = text.indexOf(' ')
        const command = spaceIdx === -1 ? text.slice(1).toLowerCase() : text.slice(1, spaceIdx).toLowerCase()
        const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1)
        const compositeId = `discord:${msg.channel.id}`
        const result = await handleCommand(compositeId, 'discord', msg.channel.id, command, args)
        if (result.handled && result.response) {
          const formatted = formatForDiscord(result.response)
          const chunks = splitMessage(formatted, 2000)
          for (const chunk of chunks) {
            await msg.reply(chunk)
          }
          return
        }
      }

      // Deliver to pipeline -- use channel ID as chatId for session persistence
      await this.onMessage({
        channelId: 'discord',
        chatId: msg.channel.id,
        text,
        isVoice: false,
        raw: msg,
      })
    })
  }

  private async registerSlashCommands(): Promise<void> {
    if (!this.client.user) return

    const commands = [
      new SlashCommandBuilder()
        .setName('agents')
        .setDescription('List available ClaudePaw agents'),
      new SlashCommandBuilder()
        .setName('newchat')
        .setDescription('Start a fresh session'),
      new SlashCommandBuilder()
        .setName('status')
        .setDescription('Show bot status'),
    ]

    try {
      const rest = new REST().setToken(this.config.botToken)
      await rest.put(
        Routes.applicationCommands(this.client.user.id),
        { body: commands.map((c) => c.toJSON()) },
      )
      logger.info('Discord slash commands registered')
    } catch (err) {
      logger.error({ err }, 'Failed to register Discord slash commands')
    }

    // Handle slash command interactions
    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return
      if (!this.isAllowed(interaction.user.id)) {
        await interaction.reply({ content: 'Not authorized.', ephemeral: true })
        return
      }

      const compositeId = `discord:${interaction.channelId}`
      const result = await handleCommand(
        compositeId,
        'discord',
        interaction.channelId,
        interaction.commandName,
        '',
      )
      if (result.handled && result.response) {
        const formatted = formatForDiscord(result.response)
        await interaction.reply(formatted.slice(0, 2000))
      }
    })
  }
}
