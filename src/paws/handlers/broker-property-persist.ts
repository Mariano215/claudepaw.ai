// src/paws/handlers/broker-property-persist.ts
//
// Post-ACT handler for re-property-scout.
//
// The ACT phase instructs the agent to output a JSON block describing the
// properties to insert and the Telegram message to send.  This handler does
// the actual work -- the agent cannot run Bash/SQLite commands in the runtime
// environment, so any Bash instructions in ACT phase text are never executed.
//
// Expected ACT output (agent must emit this JSON block):
// ```json
// {
//   "actions": [
//     {
//       "type": "insert_deal",
//       "id": "507-school-st-19070",
//       "address": "507 School St, Morton PA",
//       "zip": "19070",
//       "list_price": 264900,
//       "deal_type": "brrrr",
//       "severity": 5,
//       "notes": "Foreclosure, 3100 sqft, 68 DOM. BRRRR candidate."
//     },
//     {
//       "type": "notify",
//       "message": "Broker Scout: 6 new flags. Top: 507 School St (Tier 1, BRRRR, sev 5). Reply analyze 507 School St for full underwrite."
//     }
//   ]
// }
// ```
//
// insert_deal fields: id (slug), address, zip, list_price, deal_type, severity, notes
// Optional: est_arv, est_rehab, est_rent_monthly, est_str_adr, est_str_occupancy
//
// notify fields: message (plain text, sent via notify.sh to ALLOWED_CHAT_ID)

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from '../../db.js'
import { logger } from '../../logger.js'
import type { PostActHandler } from './index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NOTIFY_SH = path.resolve(__dirname, '../../../scripts/notify.sh')
const PROJECT_ID = 'broker'
const SOURCE_PAW_ID = 're-property-scout'

interface InsertDealAction {
  type: 'insert_deal'
  id: string
  address: string
  zip?: string
  list_price?: number
  est_arv?: number
  est_rehab?: number
  est_rent_monthly?: number
  est_str_adr?: number
  est_str_occupancy?: number
  deal_type?: string
  severity?: number
  notes?: string
}

interface NotifyAction {
  type: 'notify'
  message: string
}

type Action = InsertDealAction | NotifyAction

interface ActOutput {
  actions: Action[]
}

/** Extract the first JSON block from agent output text. */
function extractJson(text: string): ActOutput | null {
  // Try fenced code block first
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fenced ? fenced[1].trim() : text

  // Find first { ... } spanning the whole object
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

function slugify(address: string): string {
  return address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export const brokerPropertyPersistHandler: PostActHandler = async (
  cycleId,
  pawId,
  _projectId,
  actOutput,
) => {
  logger.info({ cycleId, pawId }, '[broker-property-persist] Running post-ACT handler')

  const parsed = extractJson(actOutput)
  if (!parsed || !Array.isArray(parsed.actions)) {
    logger.warn(
      { cycleId, pawId, preview: actOutput.slice(0, 300) },
      '[broker-property-persist] No valid JSON action block in ACT output — nothing persisted',
    )
    return
  }

  const db = getDb()
  const now = Date.now()
  let inserted = 0
  let notified = false

  for (const action of parsed.actions) {
    if (action.type === 'insert_deal') {
      const id = action.id || slugify(action.address || `deal-${now}`)
      try {
        const result = db.prepare(`
          INSERT OR IGNORE INTO deals
            (id, project_id, source_paw_id, address, zip, list_price,
             est_arv, est_rehab, est_rent_monthly, est_str_adr, est_str_occupancy,
             deal_type, status, severity, notes, created_at, updated_at)
          VALUES
            (?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?,
             ?, 'sourced', ?, ?, ?, ?)
        `).run(
          id,
          PROJECT_ID,
          SOURCE_PAW_ID,
          action.address ?? '',
          action.zip ?? null,
          action.list_price ?? null,
          action.est_arv ?? null,
          action.est_rehab ?? null,
          action.est_rent_monthly ?? null,
          action.est_str_adr ?? null,
          action.est_str_occupancy ?? null,
          action.deal_type ?? null,
          action.severity ?? null,
          action.notes ?? null,
          now,
          now,
        )
        if (result.changes > 0) {
          inserted++
          logger.info({ cycleId, id, address: action.address }, '[broker-property-persist] Deal inserted')
        } else {
          logger.debug({ cycleId, id }, '[broker-property-persist] Deal already exists (OR IGNORE)')
        }
      } catch (err) {
        logger.error({ cycleId, id, err }, '[broker-property-persist] Failed to insert deal')
      }
    } else if (action.type === 'notify' && !notified) {
      try {
        execFileSync('/bin/bash', [NOTIFY_SH, action.message], { timeout: 10_000 })
        notified = true
        logger.info({ cycleId }, '[broker-property-persist] Telegram notification sent')
      } catch (err) {
        logger.warn({ cycleId, err }, '[broker-property-persist] notify.sh failed')
      }
    }
  }

  logger.info(
    { cycleId, pawId, inserted, notified },
    '[broker-property-persist] Handler complete',
  )

  // If agent gave us no notify action but we inserted deals, send a fallback summary
  if (inserted > 0 && !notified) {
    const msg = `Broker Scout (handler): ${inserted} deal${inserted === 1 ? '' : 's'} persisted from cycle ${cycleId.slice(0, 8)}.`
    try {
      execFileSync('/bin/bash', [NOTIFY_SH, msg], { timeout: 10_000 })
    } catch {
      // Non-fatal
    }
  }
}
