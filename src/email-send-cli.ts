#!/usr/bin/env node
/**
 * email-send-cli.ts
 * Minimal CLI wrapper around sendEmail for use by Paw ACT phases.
 *
 * Usage:
 *   node dist/email-send-cli.js <to> <subject> <html-file>
 *
 * Exits 0 on success, 1 on failure.
 */
import { readFileSync } from 'node:fs'
import { initDatabase } from './db.js'
import { sendEmail } from './google/gmail.js'

const [, , to, subject, htmlFile] = process.argv

if (!to || !subject || !htmlFile) {
  console.error('Usage: email-send-cli.js <to> <subject> <html-file>')
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

const result = await sendEmail({ to, subject, htmlBody })

if (!result.success) {
  console.error('Send failed:', result.error)
  process.exit(1)
}

console.log('Sent:', result.messageId)
