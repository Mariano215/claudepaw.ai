// src/paws/handlers/broker-weekly-email.ts
//
// Post-ACT handler for re-property-weekly-digest.
//
// The agent's ACT phase outputs a JSON block with the email content.
// This handler sends it via the existing Gmail OAuth pipeline.
//
// Expected ACT output:
// ```json
// {
//   "actions": [
//     {
//       "type": "send_email",
//       "subject": "Broker Scout Weekly: 4 new deals — week of May 5",
//       "html_body": "<html>...</html>"
//     }
//   ]
// }
// ```
//
// Falls back to a Telegram summary via notifyOwner if email fails.
// If no deals this week, outputs: {"actions":[]} (no email sent, no Telegram).

import { sendEmail } from '../../google/gmail.js'
import { logger } from '../../logger.js'
import { notifyOwner } from '../../notify.js'
import { gateEmailSend } from '../../policy-gates.js'
import type { PostActHandler } from './index.js'

const PROJECT_ID = 'broker'
const RECIPIENT = process.env.DAILY_REPORT_TO || ''

interface SendEmailAction {
  type: 'send_email'
  subject: string
  html_body: string
}

interface NotifyAction {
  type: 'notify'
  message: string
}

type Action = SendEmailAction | NotifyAction

interface ActOutput {
  actions: Action[]
}

function extractJson(text: string): ActOutput | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1].trim() : text
  const start = raw.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let end = -1
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++
    else if (raw[i] === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return null
  try {
    return JSON.parse(raw.slice(start, end + 1)) as ActOutput
  } catch {
    return null
  }
}

export const brokerWeeklyEmailHandler: PostActHandler = async (
  cycleId,
  pawId,
  projectId,
  actOutput,
) => {
  logger.info({ cycleId, pawId }, '[broker-weekly-email] Running post-ACT handler')

  const parsed = extractJson(actOutput)
  if (!parsed || !Array.isArray(parsed.actions) || parsed.actions.length === 0) {
    logger.debug({ cycleId }, '[broker-weekly-email] No actions (no deals this week — skipping email)')
    return
  }

  for (const action of parsed.actions) {
    if (action.type === 'send_email') {
      logger.info({ cycleId, subject: action.subject }, '[broker-weekly-email] Sending email')
      const gated = await gateEmailSend(
        projectId,
        { to: RECIPIENT, subject: action.subject },
        () => sendEmail({ to: RECIPIENT, subject: action.subject, htmlBody: action.html_body }),
      )
      // A gate refusal (denied or parked) is not a send failure, so it never
      // falls back to the Telegram notice below. Only a real send failure does.
      if (gated.kind === 'denied') {
        logger.warn({ cycleId }, '[broker-weekly-email] Email refused by action policy (email.send = never)')
        continue
      }
      if (gated.kind === 'parked') {
        logger.warn({ cycleId, cardId: gated.cardId }, '[broker-weekly-email] Email held by action policy')
        continue
      }
      const result = gated.result
      if (result.success) {
        logger.info({ cycleId, messageId: result.messageId }, '[broker-weekly-email] Email sent')
        // Telegram ping on success
        await notifyOwner(`Broker weekly digest sent to ${RECIPIENT}. ${action.subject}`, PROJECT_ID).catch(() => { /* non-fatal */ })
      } else {
        logger.error({ cycleId, err: result.error }, '[broker-weekly-email] Email failed — sending Telegram fallback')
        await notifyOwner(`Broker weekly digest email failed: ${result.error ?? 'unknown'}. Check dashboard for this week's deals.`, PROJECT_ID).catch(() => { /* non-fatal */ })
      }
    } else if (action.type === 'notify') {
      await notifyOwner(action.message, PROJECT_ID).catch(() => { /* non-fatal */ })
    }
  }
}
