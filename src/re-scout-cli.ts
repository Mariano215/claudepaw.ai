#!/usr/bin/env node
/**
 * re-scout-cli.ts
 * Read a structured Property Scout JSON report, render the HTML email with
 * inline OSM static maps, and send it via Gmail.
 *
 * Usage:
 *   node dist/re-scout-cli.js <json-file> [--to <email>] [--dry-run]
 *
 * Defaults:
 *   --to: 
 *
 * Exit codes:
 *   0 = email sent (or dry-run saved to /tmp)
 *   1 = render or send failure
 *   2 = invalid input JSON
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { initDatabase } from './db.js'
import { sendEmail } from './google/gmail.js'
import { renderReport, type ReportData } from './re-scout/render.js'

const DEFAULT_TO = ''

function parseArgs(argv: string[]): {
  jsonFile: string
  to: string
  dryRun: boolean
} {
  const args = argv.slice(2)
  if (args.length === 0 || args[0].startsWith('--')) {
    console.error(
      'Usage: re-scout-cli.js <json-file> [--to <email>] [--dry-run]',
    )
    process.exit(1)
  }
  const jsonFile = args[0]
  let to = DEFAULT_TO
  let dryRun = false
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === '--to') {
      const next = args[i + 1]
      if (!next) {
        console.error('--to requires a value')
        process.exit(1)
      }
      to = next
      i++
    } else if (a === '--dry-run') {
      dryRun = true
    } else {
      console.error(`Unknown flag: ${a}`)
      process.exit(1)
    }
  }
  return { jsonFile, to, dryRun }
}

function validateReport(raw: unknown): ReportData {
  if (!raw || typeof raw !== 'object') {
    throw new Error('input is not an object')
  }
  const r = raw as Record<string, unknown>
  if (typeof r.report_date !== 'string') {
    throw new Error('report_date is required (string YYYY-MM-DD)')
  }
  if (!Array.isArray(r.properties)) {
    throw new Error('properties is required (array)')
  }
  for (const [i, p] of r.properties.entries()) {
    if (!p || typeof p !== 'object') {
      throw new Error(`properties[${i}] is not an object`)
    }
    const pp = p as Record<string, unknown>
    const needNum = ['price', 'severity', 'latitude', 'longitude'] as const
    for (const k of needNum) {
      if (typeof pp[k] !== 'number' || !Number.isFinite(pp[k] as number)) {
        throw new Error(`properties[${i}].${k} must be a finite number`)
      }
    }
    const needStr = ['id', 'address', 'zip', 'title', 'why_flagged'] as const
    for (const k of needStr) {
      if (typeof pp[k] !== 'string' || (pp[k] as string).length === 0) {
        throw new Error(`properties[${i}].${k} must be a non-empty string`)
      }
    }
  }
  return r as unknown as ReportData
}

const { jsonFile, to, dryRun } = parseArgs(process.argv)

let rawJson: unknown
try {
  rawJson = JSON.parse(readFileSync(jsonFile, 'utf-8'))
} catch (err) {
  console.error(`Failed to read or parse ${jsonFile}:`, err)
  process.exit(2)
}

let data: ReportData
try {
  data = validateReport(rawJson)
} catch (err) {
  console.error(`Invalid report data: ${err instanceof Error ? err.message : err}`)
  process.exit(2)
}

if (data.properties.length === 0) {
  console.log('No properties in report -- skipping email.')
  process.exit(0)
}

let rendered
try {
  rendered = await renderReport(data)
} catch (err) {
  console.error('Render failed:', err)
  process.exit(1)
}

// Always write the HTML preview to /tmp so we have a debuggable artifact.
const htmlPath = `/tmp/re-scout-${data.report_date}.html`
writeFileSync(htmlPath, rendered.html)
console.log(`Wrote HTML preview: ${htmlPath}`)

if (dryRun) {
  console.log(`Dry run -- would send to ${to}, subject: ${rendered.subject}`)
  console.log(`Inline images: ${rendered.inlineImages.length}`)
  // Also save the first map for eyeball verification
  if (rendered.inlineImages[0]) {
    const mapPath = `/tmp/re-scout-${data.report_date}-map-0.png`
    writeFileSync(mapPath, rendered.inlineImages[0].data)
    console.log(`Saved first map preview: ${mapPath}`)
  }
  process.exit(0)
}

initDatabase()

const result = await sendEmail({
  to,
  subject: rendered.subject,
  htmlBody: rendered.html,
  inlineImages: rendered.inlineImages,
})

if (!result.success) {
  console.error('Send failed:', result.error)
  process.exit(1)
}

console.log(`Sent: ${result.messageId} (${rendered.inlineImages.length} maps inline)`)
