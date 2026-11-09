// ---------------------------------------------------------------------------
// WhatsApp channel
//
// Uses @whiskeysockets/baileys for WhatsApp Web multi-device protocol.
// First run requires QR code scan. Session persists to disk.
// ---------------------------------------------------------------------------

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys'
import type { WASocket, proto } from '@whiskeysockets/baileys'
import { mkdirSync } from 'node:fs'
import type {
  Channel,
  ChannelCapabilities,
  IncomingMessage,
  OnMessageCallback,
  SendOptions,
} from './types.js'
import { formatForWhatsApp, splitMessage } from './formatters.js'
import { handleCommand } from '../pipeline.js'
import { logger } from '../logger.js'

export interface WhatsAppChannelConfig {
  authDir: string
  allowedNumbers: string[]
}

const SEND_DELAY_MS = 1500 // Delay between sends to avoid rate limiting

export class WhatsAppChannel implements Channel {
  readonly id = 'whatsapp'
  readonly name = 'WhatsApp'

  private config: WhatsAppChannelConfig
  private onMessage: OnMessageCallback
  private _running = false
  private sock: WASocket | null = null
  private needsReauth = false

  constructor(config: WhatsAppChannelConfig, onMessage: OnMessageCallback) {
    this.config = config
    this.onMessage = onMessage
  }

  // -- Lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (this.config.allowedNumbers.length === 0) {
      throw new Error('WHATSAPP_ALLOWED_NUMBERS not configured')
    }

    mkdirSync(this.config.authDir, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir)
    const { version } = await fetchLatestBaileysVersion()

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger as any),
      },
      printQRInTerminal: true, // User scans QR on first run
      logger: logger as any,
    })

    // Save credentials on update
    this.sock.ev.on('creds.update', saveCreds)

    // Connection state
    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut

        if (shouldReconnect) {
          logger.warn({ statusCode }, 'WhatsApp connection closed, reconnecting...')
          this.start().catch((err) => {
            logger.error({ err }, 'WhatsApp reconnect failed')
            this.needsReauth = true
          })
        } else {
          logger.warn('WhatsApp logged out -- needs QR rescan')
          this.needsReauth = true
          this._running = false
        }
      } else if (connection === 'open') {
        this._running = true
        this.needsReauth = false
        logger.info('WhatsApp channel connected')
      }
    })

    // Incoming messages
    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        await this.handleIncoming(msg)
      }
    })
  }

  async stop(): Promise<void> {
    this._running = false
    if (this.sock) {
      this.sock.end(undefined)
      this.sock = null
    }
  }

  isRunning(): boolean {
    return this._running && !this.needsReauth
  }

  // -- Outbound -----------------------------------------------------------

  async send(chatId: string, text: string, _opts?: SendOptions): Promise<void> {
    if (!this.sock || this.needsReauth) {
      logger.error('WhatsApp: cannot send -- not connected')
      return
    }

    const jid = this.toJid(chatId)
    const formatted = formatForWhatsApp(text)
    const chunks = splitMessage(formatted, 4096)

    for (const chunk of chunks) {
      await this.sock.sendMessage(jid, { text: chunk })
      // Rate limit delay
      if (chunks.length > 1) {
        await sleep(SEND_DELAY_MS)
      }
    }
  }

  async sendVoice(chatId: string, audio: Buffer, text?: string): Promise<void> {
    if (!this.sock || this.needsReauth) return

    const jid = this.toJid(chatId)
    await this.sock.sendMessage(jid, {
      audio,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true, // Push-to-talk style (plays inline)
    })

    if (text && text.length > 200) {
      await sleep(SEND_DELAY_MS)
      await this.send(chatId, text)
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.sock) return
    try {
      await this.sock.sendPresenceUpdate('composing', this.toJid(chatId))
    } catch { /* ignore */ }
  }

  // -- Introspection ------------------------------------------------------

  capabilities(): ChannelCapabilities {
    return {
      voice: true,
      media: true,
      formatting: 'whatsapp',
      maxMessageLength: 4096,
      typing: true,
    }
  }

  // -- Internal -----------------------------------------------------------

  private async handleIncoming(msg: proto.IWebMessageInfo): Promise<void> {
    // Skip non-user messages
    if (!msg.message || !msg.key || msg.key.fromMe) return

    // Extract sender
    const jid = msg.key.remoteJid
    if (!jid) return

    // Skip group messages (only DMs)
    if (jid.endsWith('@g.us')) return

    // Extract phone number from JID
    const phone = this.fromJid(jid)

    // Auth check
    if (!this.isAllowed(phone)) {
      logger.debug({ phone }, 'WhatsApp message from non-allowed number, skipping')
      return
    }

    // Extract text
    const text =
      msg.message.conversation ??
      msg.message.extendedTextMessage?.text ??
      ''

    if (!text.trim()) return

    // Check for commands
    if (text.startsWith('/')) {
      const spaceIdx = text.indexOf(' ')
      const command = spaceIdx === -1 ? text.slice(1).toLowerCase() : text.slice(1, spaceIdx).toLowerCase()
      const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1)
      const compositeId = `whatsapp:${phone}`
      const result = await handleCommand(compositeId, 'whatsapp', phone, command, args)
      if (result.handled && result.response) {
        await this.send(phone, result.response)
        return
      }
    }

    await this.onMessage({
      channelId: 'whatsapp',
      chatId: phone,
      text: text.trim(),
      isVoice: false,
      raw: msg,
    })
  }

  private isAllowed(phone: string): boolean {
    // Normalize: strip + and compare
    const normalized = phone.replace(/\+/g, '')
    return this.config.allowedNumbers.some(
      (n) => n.replace(/\+/g, '') === normalized,
    )
  }

  private toJid(phone: string): string {
    const clean = phone.replace(/\+/g, '').replace(/\s/g, '')
    return `${clean}@s.whatsapp.net`
  }

  private fromJid(jid: string): string {
    return '+' + jid.replace('@s.whatsapp.net', '')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
