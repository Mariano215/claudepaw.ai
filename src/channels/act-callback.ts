// The owner's answer to a policy approval card.
//
// Approve moves the card to `approved`, the card runner picks it up on the
// next scheduler tick. Deny moves it to `rejected`. Both write one
// action_audit row so the tap is auditable next to the request.
import { getActionItem } from '../db.js'
import { transitionActionItem } from '../action-items.js'
import { writeAudit } from '../policy.js'
import { logger } from '../logger.js'

export function handleActCallback(
  cardId: string,
  approved: boolean,
  actor: string,
): { ok: boolean; message: string } {
  const item = getActionItem(cardId)
  if (!item) return { ok: false, message: `Card not found: ${cardId}` }

  if (item.status !== 'proposed') {
    return { ok: true, message: `Card ${cardId} was already ${item.status}.` }
  }

  const to = approved ? 'approved' : 'rejected'
  try {
    transitionActionItem(cardId, to, actor)
  } catch (err) {
    logger.error({ err, cardId, to }, 'act callback transition failed')
    return { ok: false, message: `Could not move card ${cardId} to ${to}.` }
  }

  writeAudit({
    ts_ms: Date.now(),
    project_id: item.project_id,
    actor,
    action_class: item.source,
    decision: approved ? 'allow' : 'deny',
    policy_value: 'ask',
    ref_table: 'action_items',
    ref_id: cardId,
    payload_hash: null,
  })

  return {
    ok: true,
    message: approved ? 'Approved. It runs on the next tick.' : 'Denied. Nothing will run.',
  }
}
