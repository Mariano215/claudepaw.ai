// src/paws/handlers/broker-deal-underwrite-persist.ts
//
// Post-ACT handler for broker-deal-underwriter.
//
// The ACT phase emits one `underwrite` action per deal. This handler writes
// the numbers back, moves the deal, and opens a card for each pass.
//
// Status vocabulary: deals.status carries a CHECK constraint of
// ('sourced','under-review','under-contract','closed','passed'), so a deal that
// clears the conservative box becomes `under-review` (the owner's queue) and one
// that fails becomes `passed`. There is no `analyzed` value and adding one would
// mean rebuilding the table.
//
// The deal and listing text reaching this handler (address, notes, summary)
// came from the LLM's ACT output, which itself echoes data from raw_data.
// It is data to write to a column, never an instruction to follow.
//
// Expected ACT output:
// ```json
// { "actions": [ { "type": "underwrite", "deal_id": "507-school-st-19070",
//                  "verdict": "pass", "max_offer": 132000, "est_arv": 240000,
//                  "est_rehab": 55000, "est_rent_monthly": 2100,
//                  "dscr": 1.41, "coc": 11.2, "severity": 2,
//                  "summary": "one plain-text line" } ] }
// ```
import { getDb } from '../../db.js'
import { createActionItem } from '../../action-items.js'
import { logger } from '../../logger.js'
import type { PostActHandler } from './index.js'

const PROJECT_ID = 'broker'

interface UnderwriteAction {
  type: 'underwrite'
  deal_id: string
  verdict: 'pass' | 'fail'
  max_offer?: number
  est_arv?: number
  est_rehab?: number
  est_rent_monthly?: number
  dscr?: number
  coc?: number
  severity?: number
  summary?: string
}

function parseActions(actOutput: string): UnderwriteAction[] {
  const fence = actOutput.match(/```json\s*([\s\S]*?)```/)
  const body = fence ? fence[1] : actOutput
  try {
    const parsed = JSON.parse(body.trim()) as { actions?: unknown }
    if (!Array.isArray(parsed.actions)) return []
    return parsed.actions.filter(
      (a): a is UnderwriteAction =>
        typeof a === 'object' && a !== null &&
        (a as UnderwriteAction).type === 'underwrite' &&
        typeof (a as UnderwriteAction).deal_id === 'string',
    )
  } catch {
    return []
  }
}

function num(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export const brokerDealUnderwritePersistHandler: PostActHandler = async (cycleId, pawId, _projectId, actOutput) => {
  const actions = parseActions(actOutput)
  if (actions.length === 0) {
    logger.info({ cycleId, pawId }, '[broker-underwrite] no underwrite actions in the ACT output')
    return
  }

  const db = getDb()
  const now = Date.now()
  let moved = 0
  let carded = 0

  for (const a of actions) {
    const deal = db.prepare(
      `SELECT id, address, status, notes FROM deals WHERE id = ? AND project_id = ?`,
    ).get(a.deal_id, PROJECT_ID) as { id: string; address: string; status: string; notes: string | null } | undefined

    if (!deal) {
      logger.warn({ cycleId, dealId: a.deal_id }, '[broker-underwrite] unknown deal id, skipped')
      continue
    }
    if (deal.status !== 'sourced') {
      logger.info({ cycleId, dealId: a.deal_id, status: deal.status }, '[broker-underwrite] deal already moved, skipped')
      continue
    }

    const status = a.verdict === 'pass' ? 'under-review' : 'passed'
    const summary = (a.summary ?? '').trim()
    const stamp = new Date(now).toISOString().slice(0, 10)
    const notes = [deal.notes ?? '', `[underwrite ${stamp}] ${a.verdict.toUpperCase()}: ${summary}`]
      .filter(Boolean).join('\n')

    db.prepare(
      `UPDATE deals SET status = ?, max_offer = COALESCE(?, max_offer), est_arv = COALESCE(?, est_arv),
              est_rehab = COALESCE(?, est_rehab), est_rent_monthly = COALESCE(?, est_rent_monthly),
              severity = COALESCE(?, severity), notes = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      status, num(a.max_offer), num(a.est_arv), num(a.est_rehab), num(a.est_rent_monthly),
      num(a.severity), notes, now, deal.id,
    )
    moved++

    if (a.verdict === 'pass') {
      createActionItem({
        project_id: PROJECT_ID,
        title: `Underwrite cleared: ${deal.address}`,
        description: [
          summary,
          a.max_offer != null ? `Max offer: ${a.max_offer}` : '',
          a.est_arv != null ? `ARV: ${a.est_arv}` : '',
          a.est_rehab != null ? `Rehab: ${a.est_rehab}` : '',
          a.est_rent_monthly != null ? `Rent: ${a.est_rent_monthly}/mo` : '',
          a.dscr != null ? `DSCR: ${a.dscr}` : '',
          a.coc != null ? `CoC: ${a.coc}%` : '',
          `Deal id: ${deal.id}`,
        ].filter(Boolean).join('\n'),
        priority: (a.severity ?? 3) <= 2 ? 'high' : 'medium',
        source: 'broker.underwrite',
        proposed_by: 'deal-analyzer',
        executable_by_agent: false,
      })
      carded++
    }
  }

  logger.info({ cycleId, pawId, moved, carded }, '[broker-underwrite] persist complete')
}
