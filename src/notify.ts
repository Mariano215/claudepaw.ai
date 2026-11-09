// One exit for the senders that used to call the Telegram API or notify.sh
// directly (.reviews/loop1-notifications.md, 1b). In the bot process this is
// ChannelManager.send, so the message is kill-switch gated, digest-buffered
// and written to channel_log. In a CLI process there is no ChannelManager, so
// the message goes into the routine buffer and the bot's next drain sends it.
//
// src/system-alert.ts is the one documented exception and stays direct: it
// exists precisely for the case where the dashboard is unreachable.
import { holdMessage } from './channels/quiet-hours.js'
import { ALLOWED_CHAT_ID } from './config.js'
import { logger } from './logger.js'

type OutboundSender = (channelId: string, chatId: string, text: string, projectId?: string) => Promise<void>

let sender: OutboundSender | null = null

export function setOutboundSender(fn: OutboundSender | null): void {
  sender = fn
}

export async function notifyOwner(text: string, projectId?: string): Promise<void> {
  if (!ALLOWED_CHAT_ID) return
  const chatId = String(ALLOWED_CHAT_ID)
  if (sender) {
    try {
      await sender('telegram', chatId, text, projectId)
      return
    } catch (err) {
      logger.warn({ err }, 'outbound sender failed, buffering instead')
    }
  }
  try {
    holdMessage('telegram', chatId, text, projectId)
  } catch (err) {
    logger.error({ err }, 'could not buffer an owner notification')
  }
}
