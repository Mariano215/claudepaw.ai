// src/paws/collectors/broker-father-broker-inbox.ts
//
// Observe-phase collector for re-father-broker-pocket-feed.
//
// Pulls Gmail messages with label `pocket/broker` since the last completed
// cycle of this paw and parses out address, zip, list_price, notes_excerpt.
//
// Auth wiring:
//   The broker project does not yet have a `google` integration installed,
//   so we resolve the OAuth client by trying projects in this order:
//     1. ctx.projectId (broker, in case the user wires it later)
//     2. 'default'      (where  is currently connected)
//     3. 'claudepaw'
//   First success wins. If all three fail (no GOOGLE_CLIENT_ID/SECRET in env,
//   or no installed integration), we ship a clean stub: gmail_reachable=false,
//   listings=[], single error explaining the dependency.
//
// Last-cycle anchor:
//   Reads paw_cycles for re-father-broker-pocket-feed completed cycles to
//   determine since_ms. Defaults to 7 days ago if no prior cycle.
//
// Parsing is regex-best-effort. Failures still produce a finding entry with
// parse_failed=true so the agent can manually review.

import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'
import { CREDENTIAL_ENCRYPTION_KEY } from '../../config.js'
import { IntegrationEngine } from '../../integrations/engine.js'
import { GoogleClient } from '../../integrations/google/client.js'
import { GmailModule } from '../../integrations/google/gmail.js'
import { googleManifest } from '../../integrations/google/manifest.js'

const MS_PER_DAY = 86_400_000
const DEFAULT_SINCE_DAYS = 7
const POCKET_LABEL = 'pocket/broker'
const PROJECT_FALLBACKS = ['default', 'claudepaw']
const MAX_RESULTS = 50
const NOTES_EXCERPT_MAX = 200

const ADDRESS_RE = /(\d{1,6}\s+[NSEW]?\.?\s*[A-Z][a-zA-Z0-9.\-' ]+\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Way|Pkwy|Parkway|Ter|Terrace|Cir|Circle))(?:\.|,|\b)/i
const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/
const PRICE_RE = /\$\s?([\d,]+)(?:\.\d+)?(?:\s?[KkMm])?/

interface PawCycleRow {
  started_at: number
  completed_at: number | null
}

interface MessagePreview {
  id: string
  threadId: string
  from: string
  to: string
  subject: string
  snippet: string
  date: string
}

interface ParsedListing {
  message_id: string
  from: string
  received_at_ms: number
  received_at_label: string
  subject: string
  address: string | null
  zip: string | null
  list_price: number | null
  notes_excerpt: string
  parse_failed: boolean
}

function findLastCycleMs(pawId: string): number | null {
  try {
    const db = getDb()
    const row = db.prepare(`
      SELECT started_at, completed_at
      FROM paw_cycles
      WHERE paw_id = ?
        AND completed_at IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT 1
    `).get(pawId) as PawCycleRow | undefined
    if (!row) return null
    return row.completed_at ?? row.started_at
  } catch (err) {
    logger.warn({ err, pawId }, '[broker-father-broker-inbox] paw_cycles lookup failed')
    return null
  }
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function parsePrice(text: string): number | null {
  const m = text.match(PRICE_RE)
  if (!m) return null
  const numeric = m[1].replace(/,/g, '')
  const base = Number(numeric)
  if (!Number.isFinite(base)) return null
  // Honor $250K / $1.5M shorthands.
  const tail = m[0].slice(-1).toLowerCase()
  if (tail === 'k') return base * 1_000
  if (tail === 'm') return base * 1_000_000
  return base
}

function extractAddress(text: string): string | null {
  const m = text.match(ADDRESS_RE)
  return m ? m[1].trim() : null
}

function extractZip(text: string): string | null {
  const m = text.match(ZIP_RE)
  return m ? m[1] : null
}

function parseGmailDate(value: string): number {
  if (!value) return Date.now()
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? Date.now() : ms
}

function buildEngine(): IntegrationEngine {
  const engine = new IntegrationEngine(CREDENTIAL_ENCRYPTION_KEY)
  engine.register(googleManifest)
  return engine
}

async function resolveAuth(
  primary: string,
  errors: string[],
): Promise<{
  auth: InstanceType<typeof import('googleapis').google.auth.OAuth2> | null
  projectUsed: string | null
}> {
  const clientId = process.env.GOOGLE_CLIENT_ID || ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || ''
  if (!clientId || !clientSecret) {
    errors.push('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set in env -- gmail integration unavailable')
    return { auth: null, projectUsed: null }
  }

  const candidates = [primary, ...PROJECT_FALLBACKS.filter((p) => p !== primary)]
  const engine = buildEngine()
  const client = new GoogleClient(engine, clientId, clientSecret)

  for (const projectId of candidates) {
    try {
      const auth = await client.ensureFreshToken(projectId)
      return { auth, projectUsed: projectId }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.info(
        { projectId, err: msg },
        '[broker-father-broker-inbox] no google integration on project, trying next',
      )
    }
  }

  errors.push(
    `No google integration connected for project '${primary}' or fallbacks (${PROJECT_FALLBACKS.join(', ')}). ` +
    "Connect via: cpaw integrations connect --project broker --service google",
  )
  return { auth: null, projectUsed: null }
}

export const brokerFatherBrokerInboxCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()

  const lastCycleMs = findLastCycleMs(ctx.pawId)
  const sinceMs = lastCycleMs ?? now - DEFAULT_SINCE_DAYS * MS_PER_DAY

  const { auth, projectUsed } = await resolveAuth(ctx.projectId, errors)
  if (!auth) {
    return {
      raw_data: {
        collected_at_ms: now,
        since_ms: sinceMs,
        listings: [],
        gmail_reachable: false,
      },
      collected_at: now,
      collector: 'broker-father-broker-inbox',
      errors,
    }
  }

  // Gmail search supports "after:" with epoch seconds.
  const afterSeconds = Math.floor(sinceMs / 1000)
  const query = `label:${POCKET_LABEL} after:${afterSeconds}`

  let previews: MessagePreview[] = []
  try {
    const gmail = new GmailModule()
    previews = await gmail.search(auth, query, { maxResults: MAX_RESULTS })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`gmail.search failed: ${msg}`)
    logger.warn(
      { err, pawId: ctx.pawId, projectUsed },
      '[broker-father-broker-inbox] gmail search failed',
    )
    return {
      raw_data: {
        collected_at_ms: now,
        since_ms: sinceMs,
        listings: [],
        gmail_reachable: false,
      },
      collected_at: now,
      collector: 'broker-father-broker-inbox',
      errors,
    }
  }

  const listings: ParsedListing[] = []
  if (previews.length > 0) {
    const gmail = new GmailModule()
    for (const p of previews) {
      let body = ''
      let receivedMs = parseGmailDate(p.date)
      try {
        const full = await gmail.read(auth, p.id)
        body = full.body || ''
        if (full.date) receivedMs = parseGmailDate(full.date)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`gmail.read failed for ${p.id}: ${msg}`)
        // Fall through with whatever we have from the preview metadata.
      }

      const haystack = `${p.subject || ''}\n${body || p.snippet || ''}`
      const address = extractAddress(haystack)
      const zip = extractZip(haystack)
      const listPrice = parsePrice(haystack)
      const excerptSrc = body || p.snippet || ''
      const notesExcerpt = excerptSrc.replace(/\s+/g, ' ').trim().slice(0, NOTES_EXCERPT_MAX)

      listings.push({
        message_id: p.id,
        from: p.from,
        received_at_ms: receivedMs,
        received_at_label: fmtDate(receivedMs),
        subject: p.subject,
        address,
        zip,
        list_price: listPrice,
        notes_excerpt: notesExcerpt,
        parse_failed: address === null,
      })
    }
  }

  const raw_data = {
    collected_at_ms: now,
    since_ms: sinceMs,
    listings,
    gmail_reachable: true,
  }

  logger.info(
    {
      pawId: ctx.pawId,
      projectUsed,
      sinceMs,
      messageCount: listings.length,
      parseFailures: listings.filter((l) => l.parse_failed).length,
    },
    '[broker-father-broker-inbox] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-father-broker-inbox',
    errors: errors.length ? errors : undefined,
  }
}
