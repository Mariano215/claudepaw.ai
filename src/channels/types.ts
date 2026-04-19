// ---------------------------------------------------------------------------
// Multi-platform communications types
// ---------------------------------------------------------------------------

/**
 * Callback channels use to deliver inbound messages to the pipeline.
 */
export type OnMessageCallback = (msg: IncomingMessage) => Promise<void>

/**
 * Every messaging platform implements this interface.
 */
export interface Channel {
  /** Short lowercase id: 'telegram', 'discord', etc. */
  id: string
  /** Display name: 'Telegram', 'Discord' */
  name: string

  // -- Lifecycle ----------------------------------------------------------
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean

  // -- Outbound -----------------------------------------------------------
  send(chatId: string, text: string, opts?: SendOptions): Promise<void>
  sendVoice(chatId: string, audio: Buffer, text?: string): Promise<void>
  sendTyping(chatId: string): Promise<void>

  // -- Introspection ------------------------------------------------------
  capabilities(): ChannelCapabilities
}

/**
 * Normalized inbound message -- platform-agnostic.
 */
export interface IncomingMessage {
  /** Which channel delivered this message */
  channelId: string
  /** Platform-specific chat or user ID */
  chatId: string
  /** Message text (or transcription for voice) */
  text: string
  /** Local path to downloaded media file */
  mediaPath?: string
  /** Type of media attached */
  mediaType?: 'photo' | 'document' | 'video' | 'voice'
  /** Was this originally a voice message? */
  isVoice: boolean
  /** Source channel for telemetry */
  source?: 'telegram' | 'scheduler' | 'api' | 'dashboard'
  /** When set by a project-locked channel, pipeline uses this directly */
  projectId?: string
  /** Pre-routed agent ID (set by /agent or shorthand commands) */
  agentId?: string
  /** Platform-specific context (Grammy ctx, Discord message, etc.) */
  raw?: unknown
}

/**
 * What this channel supports.
 */
export interface ChannelCapabilities {
  voice: boolean
  media: boolean
  formatting: 'html' | 'markdown' | 'mrkdwn' | 'whatsapp' | 'plain'
  maxMessageLength: number
  typing: boolean
}

/**
 * Options for outbound messages.
 */
export interface SendOptions {
  parseMode?: string
  replyToMessageId?: string
}

/**
 * Channel constructor config -- each channel reads what it needs from this.
 */
export interface ChannelConfig {
  /** Telegram */
  telegramBotToken?: string
  telegramAllowedChatId?: string

  /** Discord */
  discordBotToken?: string
  discordAllowedUserIds?: string[]

  /** WhatsApp */
  whatsappAuthDir?: string
  whatsappAllowedNumbers?: string[]

  /** Slack */
  slackBotToken?: string
  slackAppToken?: string
  slackAllowedUserIds?: string[]

  /** iMessage */
  imessageAllowedHandles?: string[]
}
