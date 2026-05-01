// src/paws/handlers/broker-pocket-persist.ts
//
// Post-ACT handler for re-father-broker-pocket-feed.
//
// Expected ACT output (agent must emit this JSON block):
// ```json
// {
//   "actions": [
//     {
//       "type": "insert_pocket",
//       "id": "gmail-message-id-abc123",
//       "address": "123 Main St, Philly PA",
//       "zip": "19103",
//       "list_price": 189000,
//       "notes": "Off-market from father broker. 3br/2ba, needs kitchen."
//     },
//     {
//       "type": "notify",
//       "message": "Father feed: 2 new pocket listings. Top: 123 Main St (Tier 1, sev 4). Reply analyze 123 Main St."
//     }
//   ]
// }
// ```
//
// If listings[] is empty, the agent should output: {"actions":[]}

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from '../../db.js'
import { logger } from '../../logger.js'
import type { PostActHandler } from './index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NOTIFY_SH = path.resolve(__dirname, '../../../scripts/notify.sh')
const PROJECT_ID = 'broker'

interface InsertPocketAction {
  type: 'insert_pocket'
  id: string
  address: string
  zip?: string
  list_price?: number
  notes?: string
  received_at?: number
}

interface NotifyAction {
  type: 'notify'
  message: string
}

type Action = InsertPocketAction | NotifyAction

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

export const brokerPocketPersistHandler: PostActHandler = async (
  cycleId,
  pawId,
  _projectId,
  actOutput,
) => {
  logger.info({ cycleId, pawId }, '[broker-pocket-persist] Running post-ACT handler')

  const parsed = extractJson(actOutput)
  if (!parsed || !Array.isArray(parsed.actions)) {
    logger.warn(
      { cycleId, pawId, preview: actOutput.slice(0, 300) },
      '[broker-pocket-persist] No valid JSON action block in ACT output — nothing persisted',
    )
    return
  }

  // Empty actions = no listings this cycle, which is fine
  if (parsed.actions.length === 0) {
    logger.debug({ cycleId }, '[broker-pocket-persist] No actions (no new pocket listings)')
    return
  }

  const db = getDb()
  const now = Date.now()
  let inserted = 0
  let notified = false

  for (const action of parsed.actions) {
    if (action.type === 'insert_pocket') {
      try {
        const result = db.prepare(`
          INSERT OR IGNORE INTO father_broker_listings
            (id, project_id, address, zip, list_price, off_market, source, notes, received_at, status, created_at)
          VALUES (?, ?, ?, ?, ?, 1, 'pocket', ?, ?, 'new', ?)
        `).run(
          action.id,
          PROJECT_ID,
          action.address ?? '',
          action.zip ?? null,
          action.list_price ?? null,
          action.notes ?? null,
          action.received_at ?? now,
          now,
        )
        if (result.changes > 0) {
          inserted++
          logger.info({ cycleId, id: action.id, address: action.address }, '[broker-pocket-persist] Pocket listing inserted')
        } else {
          logger.debug({ cycleId, id: action.id }, '[broker-pocket-persist] Already exists (OR IGNORE)')
        }
      } catch (err) {
        logger.error({ cycleId, id: action.id, err }, '[broker-pocket-persist] Insert failed')
      }
    } else if (action.type === 'notify' && !notified) {
      try {
        execFileSync('/bin/bash', [NOTIFY_SH, action.message], { timeout: 10_000 })
        notified = true
        logger.info({ cycleId }, '[broker-pocket-persist] Telegram notification sent')
      } catch (err) {
        logger.warn({ cycleId, err }, '[broker-pocket-persist] notify.sh failed')
      }
    }
  }

  logger.info({ cycleId, pawId, inserted, notified }, '[broker-pocket-persist] Handler complete')

  if (inserted > 0 && !notified) {
    const msg = `Father feed (handler): ${inserted} pocket listing${inserted === 1 ? '' : 's'} saved from cycle ${cycleId.slice(0, 8)}.`
    try {
      execFileSync('/bin/bash', [NOTIFY_SH, msg], { timeout: 10_000 })
    } catch { /* non-fatal */ }
  }
}
