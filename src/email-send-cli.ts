#!/usr/bin/env node
/**
 * email-send-cli.ts
 * Minimal CLI wrapper around sendEmail for use by Paw ACT phases.
 *
 * Usage:
 *   node dist/email-send-cli.js <to> <subject> <html-file>
 *
 * The project comes from CLAUDEPAW_PROJECT_ID (default 'default'), and its
 * email.send policy decides: 'ask' parks an approval card and exits 2 without
 * sending, so the caller must treat exit 2 as parked, not as a failure.
 *
 * Exits 0 on success, 1 on failure.
 */
import { readFileSync } from 'node:fs'
import { initDatabase } from './db.js'
import { sendEmail } from './google/gmail.js'
import { gateEmailSend } from './policy-gates.js'

const [, , to, subject, htmlFile] = process.argv

if (!to || !subject || !htmlFile) {
  console.error('Usage: email-send-cli.js <to> <subject> <html-file>')
  console.error("Project comes from CLAUDEPAW_PROJECT_ID (default 'default'); an email.send policy of ask parks a card and exits 2.")
  process.exit(1)
}

let htmlBody: string
try {
  htmlBody = readFileSync(htmlFile, 'utf-8')
} catch (err) {
  console.error(`Failed to read HTML file: ${htmlFile}`, err)
  process.exit(1)
}

initDatabase()

const projectId = process.env.CLAUDEPAW_PROJECT_ID ?? 'default'
const gated = await gateEmailSend(projectId, { to, subject }, () => sendEmail({ to, subject, htmlBody }))

if (gated.kind === 'denied') {
  console.error('Send failed: email.send refused by action policy')
  process.exit(1)
}

if (gated.kind === 'parked') {
  console.error(`Send held for approval (card ${gated.cardId ?? 'unknown'})`)
  process.exit(2)
}

const result = gated.result

if (!result.success) {
  console.error('Send failed:', result.error)
  process.exit(1)
}

console.log('Sent:', result.messageId)
