// ---------------------------------------------------------------------------
// Telegram channel -- refactored from bot.ts
//
// Owns the Grammy bot, command handlers, and Telegram-specific behavior.
// Message processing delegated to pipeline.ts via onMessage callback.
// ---------------------------------------------------------------------------

import { Bot, InputFile } from 'grammy'
import type { Context } from 'grammy'
import type {
  Channel,
  ChannelCapabilities,
  IncomingMessage,
  OnMessageCallback,
  SendOptions,
} from './types.js'
import { formatForTelegram, splitMessage } from './formatters.js'
import { handleCommand } from '../pipeline.js'
import { downloadMedia, buildPhotoMessage, buildDocumentMessage, buildVideoMessage } from '../media.js'
import { transcribeAudio, voiceCapabilities } from '../voice.js'
import { reportFeedItem, reportMetric } from '../dashboard.js'
import { getSoul, getAllSouls } from '../souls.js'
import { logger } from '../logger.js'
import {
  dismissFinding,
  dismissAllForPaw,
  dashboardReplyFor,
  runAutoFix,
} from '../paws/finding-actions.js'
import { getFinding, updateFindingStatus, getOpenFindingsByIds } from '../db.js'

/** Tracks in-flight pf:fix: agent runs to prevent duplicate spawns on double-tap. */
const runningFixes = new Set<string>()

export interface TelegramChannelConfig {
  botToken: string
  allowedChatIds: string[]
  projectId?: string
  channelId?: string
}

export class TelegramChannel implements Channel {
  readonly id: string
  readonly name = 'Telegram'

  private bot: Bot
  private config: TelegramChannelConfig
  private onMessage: OnMessageCallback
  private _running = false

  constructor(config: TelegramChannelConfig, onMessage: OnMessageCallback) {
    this.config = config
    this.id = config.channelId ?? 'telegram'
    this.onMessage = onMessage
    this.bot = new Bot(config.botToken)
  }

  // -- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (!this.config.botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN not set')
    }

    this.registerMiddleware()
    this.registerCommands()
    this.registerMessageHandlers()
    this.registerCallbackHandlers()
    this.registerErrorHandler()

    this.startPollingWithRetry()
  }

  private startPollingWithRetry(attempt = 1): void {
    const maxAttempts = 5
    const baseDelay = 3000 // 3 seconds

    this.bot.start({
      onStart: (botInfo) => {
        logger.info({ username: botInfo.username }, 'Telegram channel running')
        this._running = true
      },
    }).catch((err: unknown) => {
      const conflictDetails = this.telegramConflictDetails(err)
      const is409 = conflictDetails !== null
      if (is409 && attempt < maxAttempts) {
        const delay = baseDelay * attempt
        logger.warn({
          channelId: this.id,
          attempt,
          maxAttempts,
          delay,
          ...conflictDetails,
        }, 'Telegram polling conflict: another process is already calling getUpdates for this bot token. Most likely cause: another ClaudePaw instance or the Claude Desktop Telegram plugin. Stop the duplicate poller and restart this channel.')
        setTimeout(() => this.startPollingWithRetry(attempt + 1), delay)
      } else {
        this._running = false
        logger.error({
          channelId: this.id,
          err,
          attempt,
          ...conflictDetails,
        }, is409
          ? 'Telegram polling failed permanently due to a token conflict. Another process is still polling this bot. Stop the duplicate poller, then restart ClaudePaw.'
          : 'Telegram polling failed permanently')
      }
    })
  }

  private telegramConflictDetails(err: unknown): { errorCode?: number; description?: string } | null {
    if (!err || typeof err !== 'object') return null
    const maybe = err as {
      message?: string
      error_code?: number
      description?: string
    }
    const description = maybe.description
    const message = maybe.message
    const errorCode = maybe.error_code
    const is409 = errorCode === 409
      || typeof description === 'string' && description.includes('terminated by other getUpdates request')
      || typeof message === 'string' && message.includes('409')
    if (!is409) return null
    return {
      errorCode,
      description,
    }
  }

  async stop(): Promise<void> {
    this._running = false
    try {
      // Release the Telegram polling slot cleanly before stopping.
      // getUpdates with timeout=0 tells Telegram "I'm done polling" and releases
      // the server-side session immediately, preventing 409 conflicts on restart.
      await this.bot.api.getUpdates({ offset: -1, timeout: 0, limit: 1 })
    } catch { /* ignore -- best effort */ }
    try {
      await this.bot.stop()
    } catch { /* ignore -- bot may already be stopped */ }
  }

  isRunning(): boolean {
    return this._running
  }

  // -- Outbound -----------------------------------------------------------

  async send(chatId: string, text: string, _opts?: SendOptions): Promise<void> {
    // Plain text only -- no HTML, no Markdown, no entity codes.
    // formatForTelegram() strips HTML tags, decodes entities, and strips markdown.
    const formatted = formatForTelegram(text)
    const chunks = splitMessage(formatted, 4096)
    for (const chunk of chunks) {
      // Intentionally no parse_mode -- plain text policy.
      await this.bot.api.sendMessage(Number(chatId), chunk)
    }
  }

  /**
   * Send a message with an inline keyboard (for approval buttons, etc.).
   * Text is still plain -- no parse_mode.
   */
  async sendWithKeyboard(
    chatId: string,
    text: string,
    keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
  ): Promise<void> {
    const formatted = formatForTelegram(text)
    const chunks = splitMessage(formatted, 4096)
    for (let i = 0; i < chunks.length; i++) {
      if (i === chunks.length - 1) {
        await this.bot.api.sendMessage(Number(chatId), chunks[i], {
          reply_markup: keyboard,
        })
      } else {
        await this.bot.api.sendMessage(Number(chatId), chunks[i])
      }
    }
  }

  async sendVoice(chatId: string, audio: Buffer, text?: string): Promise<void> {
    await this.bot.api.sendVoice(Number(chatId), new InputFile(audio, 'reply.ogg'))
    // Also send text for reference if it's long
    if (text && text.length > 200) {
      await this.send(chatId, text)
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(Number(chatId), 'typing')
    } catch { /* ignore */ }
  }

  // -- Introspection ------------------------------------------------------

  capabilities(): ChannelCapabilities {
    return {
      voice: true,
      media: true,
      // Plain text only -- by user policy. We never send HTML or Markdown
      // formatted messages to Telegram.
      formatting: 'plain',
      maxMessageLength: 4096,
      typing: true,
    }
  }

  // -- Grammy access for scheduler/dashboard integration ------------------

  getBot(): Bot {
    return this.bot
  }

  // -- Internal -----------------------------------------------------------

  private isAuthorised(chatId: number): boolean {
    // FAIL-CLOSED: empty allowlist means reject everyone.
    // Previous behavior (fail-open) meant any user who found the bot token
    // could interact with agents and run tools. This is a CRITICAL security
    // boundary; never open it by accident.
    if (this.config.allowedChatIds.length === 0) {
      logger.error({ chatId }, 'Telegram bot has empty allowlist, rejecting all messages (set ALLOWED_CHAT_ID in env or project credentials)')
      return false
    }
    return this.config.allowedChatIds.includes(String(chatId))
  }

  private compositeId(chatId: number): string {
    return `telegram:${chatId}`
  }

  private registerMiddleware(): void {
    this.bot.use(async (ctx, next) => {
      if (ctx.chat && !this.isAuthorised(ctx.chat.id)) {
        logger.warn({ chatId: ctx.chat.id }, 'Unauthorized Telegram access attempt')
        await ctx.reply('Not authorized. Your chat ID: ' + ctx.chat.id)
        return
      }
      await next()
    })
  }

  private registerCommands(): void {
    const bot = this.bot

    bot.command('start', async (ctx) => {
      await ctx.reply(
        'ClaudePaw is online.\n\n' +
        'Send me any message and I\'ll run it through Claude Code.\n\n' +
        'Commands:\n' +
        '/agents - List available agents\n' +
        '/agent <name> <msg> - Talk to a specific agent\n' +
        '/reset [name] - Clear agent or main session\n' +
        '/newchat - Start a fresh main session\n' +
        '/memory - Show recent memories\n' +
        '/voice - Toggle voice replies\n' +
        '/schedule - List scheduled tasks\n' +
        '/status - Bot status',
      )
    })

    bot.command('chatid', async (ctx) => {
      await ctx.reply(`Your chat ID: ${ctx.chat!.id}`)
    })

    // Shared commands routed through pipeline.handleCommand
    for (const cmd of ['newchat', 'forget', 'voice', 'schedule', 'status', 'agents', 'reset', 'switch', 'plugins', 'todo']) {
      bot.command(cmd, async (ctx) => {
        const chatId = String(ctx.chat!.id)
        const args = (ctx.match as string ?? '').trim()
        const result = await handleCommand(
          this.compositeId(ctx.chat!.id),
          'telegram',
          chatId,
          cmd,
          args,
        )
        if (result.handled && result.response) {
          const formatted = formatForTelegram(result.response)
          const chunks = splitMessage(formatted, 4096)
          for (const chunk of chunks) {
            await ctx.reply(chunk)
          }
        }
      })
    }

    // Memory command (Telegram-specific formatting)
    bot.command('memory', async (ctx) => {
      const { getRecentMemories } = await import('../db.js')
      const memories = getRecentMemories(String(ctx.chat!.id), 10)
      if (memories.length === 0) {
        await ctx.reply('No memories stored yet.')
        return
      }
      const lines = memories.map((m, i) =>
        `${i + 1}. [${m.sector}] ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`,
      )
      await ctx.reply(lines.join('\n'))
    })

    // /agent <name> [message]
    bot.command('agent', async (ctx) => {
      const args = (ctx.match as string ?? '').trim()
      if (!args) {
        await ctx.reply('Usage: /agent <name> [message]\nUse /agents to see available agents.')
        return
      }
      const spaceIdx = args.indexOf(' ')
      const name = spaceIdx === -1 ? args.toLowerCase() : args.slice(0, spaceIdx).toLowerCase()
      const msgPart = spaceIdx === -1 ? '' : args.slice(spaceIdx + 1).trim()

      const soul = getSoul(name, this.config.projectId)
      if (!soul) {
        await ctx.reply(`Unknown agent "${name}". Use /agents to see available agents.`)
        return
      }

      if (!msgPart) {
        const keywords = soul.keywords.length > 0 ? soul.keywords.join(', ') : 'none'
        const caps = soul.capabilities.length > 0 ? soul.capabilities.join(', ') : 'none'
        await ctx.reply(
          `${soul.emoji} ${soul.name}\n` +
          `Role: ${soul.role}\n` +
          `Mode: ${soul.mode}\n` +
          `Keywords: ${keywords}\n` +
          `Capabilities: ${caps}\n\n` +
          `Send a message: /agent ${soul.id} <message>`,
        )
        return
      }

      await this.onMessage({
        channelId: this.id,
        chatId: String(ctx.chat!.id),
        text: msgPart,
        agentId: soul.id,
        isVoice: false,
        source: 'telegram',
        projectId: this.config.projectId,
        raw: ctx,
      })
    })

    // Dynamic per-agent shorthand commands
    const projectSouls = getAllSouls(this.config.projectId)
    logger.info({ channelId: this.id, projectId: this.config.projectId, agents: projectSouls.map(s => s.id) }, 'Registering agent shorthand commands')
    for (const soul of projectSouls) {
      bot.command(soul.id, async (ctx) => {
        const msgPart = (ctx.match as string ?? '').trim()
        if (!msgPart) {
          await ctx.reply(
            `${soul.emoji} ${soul.name} -- ${soul.role}\n\nUsage: /${soul.id} <message>`,
          )
          return
        }
        await this.onMessage({
          channelId: this.id,
          chatId: String(ctx.chat!.id),
          text: msgPart,
          agentId: soul.id,
          isVoice: false,
          source: 'telegram',
          projectId: this.config.projectId,
          raw: ctx,
        })
      })
    }
  }

  private registerMessageHandlers(): void {
    const bot = this.bot

    // Text messages
    bot.on('message:text', async (ctx) => {
      const text = ctx.message.text
      if (text.startsWith('/')) {
        const cmd = text.split(/\s/)[0].replace(/^\//, '').replace(/@.*$/, '').toLowerCase()
        const agentIds = getAllSouls(this.config.projectId).map(s => s.id)
        const knownCmds = ['start', 'chatid', 'newchat', 'forget', 'voice', 'schedule', 'status', 'agents', 'reset', 'agent', 'memory', 'switch', 'plugins']
        if (![...knownCmds, ...agentIds].includes(cmd)) {
          await ctx.reply(`Unknown command: /${cmd}\nUse /agents to see available agents.`)
        }
        return
      }
      await this.onMessage({
        channelId: this.id,
        chatId: String(ctx.chat!.id),
        text,
        isVoice: false,
        source: 'telegram',
        projectId: this.config.projectId,
        raw: ctx,
      })
    })

    // Voice notes
    bot.on('message:voice', async (ctx) => {
      const voice = ctx.message.voice
      try {
        reportFeedItem('system', 'Voice note received', `${voice.duration}s`)
        reportMetric('telegram', 'voice_received', 1)
        const localPath = await downloadMedia(this.config.botToken, voice.file_id, 'voice.oga')
        const transcript = await transcribeAudio(localPath)
        logger.info({ transcript: transcript.slice(0, 100) }, 'Voice transcribed')
        reportFeedItem('system', 'Voice transcribed', transcript.slice(0, 60))
        await this.onMessage({
          channelId: this.id,
          chatId: String(ctx.chat!.id),
          text: `[Voice transcribed]: ${transcript}`,
          isVoice: true,
          source: 'telegram',
          projectId: this.config.projectId,
          raw: ctx,
        })
      } catch (err) {
        logger.error({ err }, 'Voice processing failed')
        await ctx.reply('Failed to process voice note.')
      }
    })

    // Photos
    bot.on('message:photo', async (ctx) => {
      const photos = ctx.message.photo
      const largest = photos[photos.length - 1]
      try {
        const localPath = await downloadMedia(this.config.botToken, largest.file_id, 'photo.jpg')
        const caption = ctx.message.caption
        const message = buildPhotoMessage(localPath, caption)
        await this.onMessage({
          channelId: this.id,
          chatId: String(ctx.chat!.id),
          text: message,
          mediaPath: localPath,
          mediaType: 'photo',
          isVoice: false,
          source: 'telegram',
          projectId: this.config.projectId,
          raw: ctx,
        })
      } catch (err) {
        logger.error({ err }, 'Photo processing failed')
        await ctx.reply('Failed to process photo.')
      }
    })

    // Documents
    bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document
      try {
        const localPath = await downloadMedia(this.config.botToken, doc.file_id, doc.file_name)
        const caption = ctx.message.caption
        const message = buildDocumentMessage(localPath, doc.file_name ?? 'document', caption)
        await this.onMessage({
          channelId: this.id,
          chatId: String(ctx.chat!.id),
          text: message,
          mediaPath: localPath,
          mediaType: 'document',
          isVoice: false,
          source: 'telegram',
          projectId: this.config.projectId,
          raw: ctx,
        })
      } catch (err) {
        logger.error({ err }, 'Document processing failed')
        await ctx.reply('Failed to process document.')
      }
    })

    // Video
    bot.on('message:video', async (ctx) => {
      const video = ctx.message.video
      try {
        const localPath = await downloadMedia(this.config.botToken, video.file_id, 'video.mp4')
        const caption = ctx.message.caption
        const message = buildVideoMessage(localPath, caption)
        await this.onMessage({
          channelId: this.id,
          chatId: String(ctx.chat!.id),
          text: message,
          mediaPath: localPath,
          mediaType: 'video',
          isVoice: false,
          source: 'telegram',
          projectId: this.config.projectId,
          raw: ctx,
        })
      } catch (err) {
        logger.error({ err }, 'Video processing failed')
        await ctx.reply('Failed to process video.')
      }
    })
  }

  private registerCallbackHandlers(): void {
    const bot = this.bot

    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data

      // --- Paw approval/skip buttons ---
      if (data.startsWith('paw:')) {
        const parts = data.split(':')
        if (parts.length !== 3) return
        const [, action, pawId] = parts
        const approved = action === 'approve'

        // Gate on the clicker's user id — not the chat. If the bot is ever in
        // a group, an inline-button callback from any group member must be
        // rejected unless that user is on the allow-list. Mirror the other
        // approval flow in this file, which passes fromUserId through to the
        // resolver.
        const fromUserId = ctx.callbackQuery.from?.id
        if (!fromUserId || !this.isAuthorised(fromUserId)) {
          logger.warn({ pawId, action, fromUserId }, 'Paw approval rejected: unauthorized user')
          try { await ctx.answerCallbackQuery({ text: 'Not authorized to approve this Paw' }) } catch { /* ignore */ }
          return
        }

        // Answer the callback query (Telegram toast) — must not block approval processing
        // if the query is expired or already answered (e.g. stale button from a previous session)
        try {
          await ctx.answerCallbackQuery({ text: approved ? 'Approving...' : 'Skipping...' })
        } catch { /* query may be expired or already answered; proceed anyway */ }

        const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.message?.chat?.id ?? '')
        try {
          const { processPawApproval } = await import('../paws/index.js')
          await processPawApproval(pawId, approved, this.send.bind(this))
          const label = approved ? 'Approved. Running ACT phase...' : 'Skipped. ACT phase will not run.'
          try {
            await ctx.editMessageText(label)
          } catch {
            // Message too old to edit — send a new one so the user gets confirmation
            if (chatId) await this.send(chatId, label).catch(() => {})
          }
        } catch (err) {
          logger.error({ err, pawId, action }, 'Paw approval callback failed')
          const msg = `Failed to process ${action} for ${pawId}: ${err instanceof Error ? err.message : String(err)}`
          if (chatId) await this.send(chatId, msg).catch(() => {})
        }
        return
      }


      // --- Paw finding actions: pf:fix:{id} | pf:dash:{id} | pf:dismiss:{id} | pf:dismiss-all:{pawId} | pf:dash-all:{pawId} ---
      if (data.startsWith('pf:')) {
        const parts = data.split(':')
        const action = parts[1]
        const targetId = parts.slice(2).join(':') // tolerate colons in ids

        const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.message?.chat?.id ?? '')
        const dashboardUrl = process.env.DASHBOARD_URL ?? 'http://localhost:3000'

        // Answer the callback immediately; never let a stale query block processing.
        const toast = {
          fix: 'Running fix…',
          dash: 'Opening dashboard…',
          'dash-all': 'Opening dashboard…',
          dismiss: 'Dismissed',
          'dismiss-all': 'Dismissing all…',
        }[action] ?? 'Processing…'
        try { await ctx.answerCallbackQuery({ text: toast }) } catch { /* expired */ }

        try {
          if (action === 'dismiss') {
            const result = await dismissFinding({
              findingId: targetId,
              getFinding,
              updateFindingStatus,
            })
            if (result.kind === 'not-found') {
              if (chatId) await this.send(chatId, 'Finding not found').catch(() => {})
            } else if (result.kind === 'already-resolved') {
              if (chatId) await this.send(chatId, `Already resolved: ${result.finding.title}`).catch(() => {})
            } else {
              if (chatId) await this.send(chatId, `✓ Dismissed: ${result.finding.title}`).catch(() => {})
            }
            return
          }

          if (action === 'dash') {
            const finding = getFinding(targetId)
            if (!finding) {
              if (chatId) await this.send(chatId, 'Finding not found').catch(() => {})
              return
            }
            if (chatId) await this.send(chatId, dashboardReplyFor(finding, dashboardUrl)).catch(() => {})
            return
          }

          if (action === 'dash-all') {
            if (chatId) await this.send(chatId, `Dashboard: ${dashboardUrl}/#security`).catch(() => {})
            return
          }

          if (action === 'dismiss-all') {
            // targetId is now "pawId:cycleStamp" — split it.
            const lastColon = targetId.lastIndexOf(':')
            const pawId = lastColon > 0 ? targetId.slice(0, lastColon) : targetId
            const cycleStamp = lastColon > 0 ? parseInt(targetId.slice(lastColon + 1), 10) : 0

            const { getLatestCycle } = await import('../paws/db.js')
            const { getDb } = await import('../db.js')
            const cycle = getLatestCycle(getDb(), pawId)

            if (!cycle) {
              if (chatId) await this.send(chatId, 'No cycles found for this paw').catch(() => {})
              return
            }

            // Stale-card check: if the latest cycle started after the card's cycle, warn and bail.
            const latestStampSec = Math.floor((cycle.started_at ?? 0) / 1000)
            if (cycleStamp > 0 && latestStampSec > cycleStamp + 1) { // 1s grace
              if (chatId) await this.send(chatId, 'This card is stale — a newer cycle has run. Open the dashboard to review current findings.').catch(() => {})
              return
            }

            const ids = (cycle.findings ?? []).map(f => f.id)
            const n = await dismissAllForPaw({
              findingIds: ids,
              getOpenFindingsByIds,
              updateFindingStatus,
            })
            if (chatId) await this.send(chatId, `✓ Dismissed ${n} finding${n === 1 ? '' : 's'}`).catch(() => {})
            return
          }

          if (action === 'fix') {
            if (runningFixes.has(targetId)) {
              if (chatId) await this.send(chatId, 'Fix already in progress for this finding').catch(() => {})
              return
            }
            runningFixes.add(targetId)
            try {
              const { runAgent } = await import('../agent.js')
              const finding = getFinding(targetId)
              if (!finding) {
                if (chatId) await this.send(chatId, 'Finding not found').catch(() => {})
                return
              }
              const agentRunner = async (prompt: string): Promise<{ text: string | null }> => {
                const { text } = await runAgent(prompt, undefined, undefined, undefined, undefined, {
                  projectId: finding.project_id,
                  source: 'paw-fix',
                }, {
                  projectId: finding.project_id,
                  agentId: 'paw-fix',
                })
                return { text }
              }
              const result = await runAutoFix({
                findingId: targetId,
                getFinding,
                updateFindingStatus,
                runAgent: agentRunner,
              })
              if (chatId) {
                if (result.kind === 'fixed') {
                  await this.send(chatId, `✓ ${result.summary}`).catch(() => {})
                } else if (result.kind === 'failed') {
                  await this.send(chatId, `Fix failed: ${result.message}`).catch(() => {})
                } else if (result.kind === 'already-resolved') {
                  await this.send(chatId, 'Already resolved').catch(() => {})
                } else {
                  await this.send(chatId, 'Finding not found').catch(() => {})
                }
              }
            } finally {
              runningFixes.delete(targetId)
            }
            return
          }

          // Unknown action — no-op.
        } catch (err) {
          logger.error({ err, action, targetId }, 'pf: callback failed')
          if (chatId) await this.send(chatId, `Action failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {})
        }
        return
      }

      // --- Blog post approval/rejection ---
      if (data.startsWith('blog_approve_') || data.startsWith('blog_reject_')) {
        const isApprove = data.startsWith('blog_approve_')
        const wpPostId = data.replace(/^blog_(approve|reject)_/, '')

        try {
          if (isApprove) {
            await ctx.answerCallbackQuery({ text: 'Publishing blog post...' })
            // Publish the WordPress draft via REST API
            const { getCredential } = await import('../credentials.js')
            const user = await getCredential('example-company', 'wordpress', 'fop_user')
            const pass = await getCredential('example-company', 'wordpress', 'fop_app_password')
            const auth = Buffer.from(`${user}:${pass}`).toString('base64')
            const resp = await fetch(`https://example.com/wp-json/wp/v2/posts/${wpPostId}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
              body: JSON.stringify({ status: 'publish' }),
            })
            if (resp.ok) {
              const post = (await resp.json()) as { link?: string; title?: { rendered?: string } }
              const title = post.title?.rendered ?? 'Blog post'
              const link = post.link ?? ''
              try {
                await ctx.editMessageText(`Published: ${title}\n${link}\n\nSocial Manager: create FB/IG posts for this.`)
              } catch { /* message may be too old */ }
              logger.info({ wpPostId, link }, 'Blog post approved and published via Telegram')
            } else {
              const errText = await resp.text()
              try { await ctx.editMessageText(`Publish failed (${resp.status}): ${errText.slice(0, 200)}`) } catch { /* */ }
              logger.error({ wpPostId, status: resp.status }, 'Blog post publish failed')
            }
          } else {
            await ctx.answerCallbackQuery({ text: 'Rejected' })
            try { await ctx.editMessageText('Blog post rejected. Will revise next cycle.') } catch { /* */ }
            logger.info({ wpPostId }, 'Blog post rejected via Telegram')
          }
        } catch (err) {
          logger.error({ err, wpPostId }, 'Blog callback handler failed')
          try { await ctx.answerCallbackQuery({ text: 'Error -- check logs' }) } catch { /* */ }
        }
        return
      }

      // --- Social post approval/rejection ---
      if (!data.startsWith('social:')) return

      const parts = data.split(':')
      if (parts.length !== 3) return
      const [, action, postId] = parts

      try {
        if (action === 'approve') {
          await ctx.answerCallbackQuery({ text: 'Publishing...' })
          const { approveAndPublish } = await import('../social/index.js')
          const result = await approveAndPublish(postId)
          if (result.published) {
            const url = result.post.platform_url ?? '(no url)'
            try {
              await ctx.editMessageText(`Published.\n${url}`)
            } catch { /* message may be too old to edit */ }
            logger.info({ postId, url }, 'Social post approved and published via Telegram')
          } else {
            try {
              await ctx.editMessageText(`Publish failed: ${result.error ?? 'unknown error'}`)
            } catch { /* ignore */ }
            logger.error({ postId, error: result.error }, 'Social post publish failed via Telegram')
          }
        } else if (action === 'reject') {
          await ctx.answerCallbackQuery({ text: 'Rejected' })
          const { reject } = await import('../social/index.js')
          const ok = reject(postId)
          try {
            await ctx.editMessageText(ok ? 'Rejected.' : 'Reject failed (wrong status?)')
          } catch { /* ignore */ }
          logger.info({ postId, ok }, 'Social post rejected via Telegram')
        } else {
          await ctx.answerCallbackQuery({ text: 'Unknown action' })
        }
      } catch (err) {
        logger.error({ err, postId, action }, 'Social callback handler failed')
        try {
          await ctx.answerCallbackQuery({ text: 'Error -- check logs' })
        } catch { /* ignore */ }
      }
    })
  }

  private registerErrorHandler(): void {
    this.bot.catch(async (err) => {
      logger.error({ err: err.error, ctx: err.ctx?.update?.update_id }, 'Telegram bot error')
      try {
        if (err.ctx) {
          await err.ctx.reply('Something went wrong processing that. Check the logs.')
        }
      } catch { /* ignore -- can't even send error message */ }
    })
  }

}
