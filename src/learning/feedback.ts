import { randomUUID } from 'node:crypto'
import {
  saveFeedback,
  savePatch,
} from '../db.js'
import { reportFeedItem, reportMetric } from '../dashboard.js'
import { logger } from '../logger.js'

// ---------------------------------------------------------------------------
// Correction detection patterns
// ---------------------------------------------------------------------------

/** Patterns that indicate the user is correcting the previous response.
 *  Each must match at the START of the message (case-insensitive). */
export const CORRECTION_PATTERNS: RegExp[] = [
  /^no[,.]?\s+i\s+(meant|want|need)/i,
  /^no[,.]?\s+that'?s?\s+(not|wrong)/i,
  /^that'?s?\s+(wrong|not\s+(right|what|correct))/i,
  /^not\s+what\s+i\s+(asked|meant|wanted)/i,
  /^try\s+again/i,
  /^actually[,.]?\s+/i,
  /^wrong[,.]?\s+/i,
  /^i\s+said\s+/i,
  /^no[,.]\s+/i,
]

/**
 * Check if a message looks like a correction of the previous response.
 */
export function isCorrection(message: string): boolean {
  const trimmed = message.trim()
  return CORRECTION_PATTERNS.some((p) => p.test(trimmed))
}

// ---------------------------------------------------------------------------
// Feedback capture
// ---------------------------------------------------------------------------

/**
 * Record a detected correction. Call when isCorrection() returns true
 * and the previous exchange is recent enough (within 5 min).
 *
 * Creates both a feedback record and a Tier 1 patch.
 */
export function captureCorrection(
  chatId: string,
  agentId: string | null,
  prevUserMessage: string,
  prevBotResponse: string,
  correctionMessage: string,
): void {
  const feedbackId = randomUUID()

  saveFeedback({
    id: feedbackId,
    chat_id: chatId,
    agent_id: agentId,
    user_message: prevUserMessage,
    bot_response: prevBotResponse,
    feedback_type: 'correction',
    feedback_note: correctionMessage,
  })

  createPatchFromFeedback(feedbackId, agentId, prevUserMessage, correctionMessage)

  const dashAgent = agentId ?? 'system'
  reportFeedItem(dashAgent, 'Feedback received', `Correction: ${correctionMessage.slice(0, 60)}`)
  reportMetric('learning', 'patches_created', 1)

  logger.info({ chatId, agentId, feedbackId }, 'Correction captured')
}

/**
 * Record explicit /bad feedback. Call from the /bad command handler.
 */
export function captureExplicitFeedback(
  chatId: string,
  agentId: string | null,
  userMessage: string,
  botResponse: string,
  reason: string,
): void {
  const feedbackId = randomUUID()

  saveFeedback({
    id: feedbackId,
    chat_id: chatId,
    agent_id: agentId,
    user_message: userMessage,
    bot_response: botResponse,
    feedback_type: 'explicit',
    feedback_note: reason,
  })

  createPatchFromFeedback(feedbackId, agentId, userMessage, reason)

  const dashAgent = agentId ?? 'system'
  reportFeedItem(dashAgent, 'Feedback received', `Explicit: ${reason.slice(0, 60)}`)
  reportMetric('learning', 'patches_created', 1)

  logger.info({ chatId, agentId, feedbackId }, 'Explicit feedback captured')
}

// ---------------------------------------------------------------------------
// Patch creation (Tier 1 -- no LLM call)
// ---------------------------------------------------------------------------

function createPatchFromFeedback(
  feedbackId: string,
  agentId: string | null,
  userMessage: string,
  feedbackNote: string,
): void {
  const topicKey = userMessage.split(/\s+/).slice(0, 3).join(' ').toLowerCase()
  const agentLabel = agentId ?? 'main assistant'
  const expiresDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const content =
    `[Learned patch - expires ${expiresDate}]\n` +
    `When handling requests about "${topicKey}" for ${agentLabel}: ${feedbackNote}\n` +
    `Context: User asked "${userMessage.slice(0, 200)}" and the response missed the mark.\n` +
    `Correction: ${feedbackNote}`

  savePatch({
    id: randomUUID(),
    agent_id: agentId,
    feedback_id: feedbackId,
    content,
  })
}
