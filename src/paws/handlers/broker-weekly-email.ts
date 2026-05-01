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
// Falls back to a Telegram summary via notify.sh if email fails.
// If no deals this week, outputs: {"actions":[]} (no email sent, no Telegram).

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendEmail } from '../../google/gmail.js'
import { logger } from '../../logger.js'
import type { PostActHandler } from './index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NOTIFY_SH = path.resolve(__dirname, '../../../scripts/notify.sh')
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
  _projectId,
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
      const result = await sendEmail({
        to: RECIPIENT,
        subject: action.subject,
        htmlBody: action.html_body,
      })
      if (result.success) {
        logger.info({ cycleId, messageId: result.messageId }, '[broker-weekly-email] Email sent')
        // Telegram ping on success
        try {
          execFileSync('/bin/bash', [NOTIFY_SH, `Broker weekly digest sent to ${RECIPIENT}. ${action.subject}`], { timeout: 10_000 })
        } catch { /* non-fatal */ }
      } else {
        logger.error({ cycleId, err: result.error }, '[broker-weekly-email] Email failed — sending Telegram fallback')
        try {
          execFileSync('/bin/bash', [NOTIFY_SH, `Broker weekly digest email failed: ${result.error ?? 'unknown'}. Check dashboard for this week's deals.`], { timeout: 10_000 })
        } catch { /* non-fatal */ }
      }
    } else if (action.type === 'notify') {
      try {
        execFileSync('/bin/bash', [NOTIFY_SH, action.message], { timeout: 10_000 })
      } catch { /* non-fatal */ }
    }
  }
}
