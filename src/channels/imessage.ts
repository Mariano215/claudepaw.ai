// ---------------------------------------------------------------------------
// iMessage channel
//
// Send via AppleScript (osascript). Receive by polling ~/Library/Messages/chat.db.
// macOS only. No external dependencies.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import type {
  Channel,
  ChannelCapabilities,
  IncomingMessage,
  OnMessageCallback,
  SendOptions,
} from './types.js'
import { stripMarkdown, splitMessage } from './formatters.js'
import { handleCommand } from '../pipeline.js'
import { logger } from '../logger.js'

const execFileAsync = promisify(execFile)

export interface IMessageChannelConfig {
  allowedHandles: string[]
  pollIntervalMs?: number
}

const MESSAGES_DB_PATH = path.join(homedir(), 'Library', 'Messages', 'chat.db')
const DEFAULT_POLL_MS = 3000

export class IMessageChannel implements Channel {
  readonly id = 'imessage'
  readonly name = 'iMessage'

  private config: IMessageChannelConfig
  private onMessage: OnMessageCallback
  private _running = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastRowId = 0
  private db: Database.Database | null = null

  constructor(config: IMessageChannelConfig, onMessage: OnMessageCallback) {
    this.config = config
    this.onMessage = onMessage
  }

  // -- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('iMessage channel only works on macOS')
    }

    if (!existsSync(MESSAGES_DB_PATH)) {
      throw new Error(`Messages database not found at ${MESSAGES_DB_PATH}`)
    }

    if (this.config.allowedHandles.length === 0) {
      throw new Error('IMESSAGE_ALLOWED_HANDLES not configured')
    }

    // Open read-only connection to Messages DB
    this.db = new Database(MESSAGES_DB_PATH, { readonly: true, fileMustExist: true })

    // Get the current max ROWID so we only process new messages
    const row = this.db.prepare('SELECT MAX(ROWID) as maxId FROM message').get() as { maxId: number } | undefined
    this.lastRowId = row?.maxId ?? 0

    // Start polling
    this._running = true
    this.pollTimer = setInterval(() => {
      this.pollMessages().catch((err) => {
        logger.error({ err }, 'iMessage poll failed')
      })
    }, this.config.pollIntervalMs ?? DEFAULT_POLL_MS)

    logger.info(
      { handles: this.config.allowedHandles.length, lastRowId: this.lastRowId },
      'iMessage channel started',
    )
  }

  async stop(): Promise<void> {
    this._running = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  isRunning(): boolean {
    return this._running
  }

  // -- Outbound -----------------------------------------------------------

  async send(chatId: string, text: string, _opts?: SendOptions): Promise<void> {
    if (!this.sanitizeHandle(chatId)) {
      throw new Error(`send: invalid chatId rejected: ${chatId}`)
    }

    const plain = stripMarkdown(text)
    const chunks = splitMessage(plain, 10000) // iMessage has no real limit but keep reasonable

    for (const chunk of chunks) {
      await this.sendViaAppleScript(chatId, chunk)
    }
  }

  async sendVoice(_chatId: string, _audio: Buffer, text?: string): Promise<void> {
    // iMessage can't send voice programmatically -- send text instead
    if (text) {
      await this.send(_chatId, text)
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // No typing indicator API for iMessage
  }

  // -- Introspection ------------------------------------------------------

  capabilities(): ChannelCapabilities {
    return {
      voice: false,
      media: false, // Can receive but not send media programmatically
      formatting: 'plain',
      maxMessageLength: 10000,
      typing: false,
    }
  }

  // -- Internal -----------------------------------------------------------

  private async sendViaAppleScript(handle: string, text: string): Promise<void> {
    // Validate handle before injecting into AppleScript
    if (!this.sanitizeHandle(handle)) {
      throw new Error(`sendViaAppleScript: invalid handle rejected: ${handle}`)
    }

    // Escape for AppleScript string
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')

    const script = `
      tell application "Messages"
        set targetService to 1st account whose service type = iMessage
        set targetBuddy to participant "${handle}" of targetService
        send "${escaped}" to targetBuddy
      end tell
    `

    try {
      await execFileAsync('osascript', ['-e', script], { timeout: 10000 })
    } catch (err) {
      logger.error({ err, handle }, 'Failed to send iMessage via AppleScript')
      throw err
    }
  }

  private async pollMessages(): Promise<void> {
    if (!this.db || !this._running) return

    try {
      // Query new messages since last poll
      const rows = this.db.prepare(`
        SELECT
          m.ROWID,
          m.text,
          m.is_from_me,
          m.date,
          h.id as handle_id
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        WHERE m.ROWID > ?
          AND m.is_from_me = 0
          AND m.text IS NOT NULL
          AND m.text != ''
        ORDER BY m.ROWID ASC
        LIMIT 20
      `).all(this.lastRowId) as Array<{
        ROWID: number
        text: string
        is_from_me: number
        date: number
        handle_id: string | null
      }>

      for (const row of rows) {
        this.lastRowId = row.ROWID

        const rawHandle = row.handle_id
        if (!rawHandle) continue

        const handle = this.sanitizeHandle(rawHandle)
        if (!handle) continue

        // Auth check
        if (!this.isAllowed(handle)) {
          logger.debug({ handle }, 'iMessage from non-allowed handle, skipping')
          continue
        }

        const text = row.text.trim()
        if (!text) continue

        // Check for commands
        if (text.startsWith('/')) {
          const spaceIdx = text.indexOf(' ')
          const command = spaceIdx === -1 ? text.slice(1).toLowerCase() : text.slice(1, spaceIdx).toLowerCase()
          const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1)
          const compositeId = `imessage:${handle}`
          const result = await handleCommand(compositeId, 'imessage', handle, command, args)
          if (result.handled && result.response) {
            await this.send(handle, result.response)
            continue
          }
        }

        // Deliver to pipeline
        await this.onMessage({
          channelId: 'imessage',
          chatId: handle,
          text,
          isVoice: false,
        })
      }
    } catch (err) {
      // Don't crash the poll loop -- the DB might be locked briefly by Messages.app
      logger.debug({ err }, 'iMessage poll query failed (likely DB lock)')
    }
  }

  private sanitizeHandle(handle: string): string | null {
    const phonePattern = /^\+?[0-9]{1,15}$/
    const emailPattern = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/
    if (phonePattern.test(handle) || emailPattern.test(handle)) {
      return handle
    }
    logger.warn({ handle }, 'iMessage handle failed sanitization, rejecting')
    return null
  }

  private isAllowed(handle: string): boolean {
    return this.config.allowedHandles.some(
      (h) => h.toLowerCase() === handle.toLowerCase(),
    )
  }
}
