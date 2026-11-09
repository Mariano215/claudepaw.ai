// One policy for every agent side effect.
//
// Values per spec 4.1: auto (do it, log it), ask (open a card, send the
// keyboard, wait), never (refuse, log). An unknown class reads as ask.
// The policy lives in the project_settings.knobs JSON under `action_policy`
// and is edited on the dashboard Settings page, per the knob rule in
// CLAUDE.md. Env vars are not consulted.
import { createHash } from 'node:crypto'
import { getActionItem, getDb, getKnob, updateActionItemFields } from './db.js'
import { logger } from './logger.js'
import { BOT_API_TOKEN, DASHBOARD_API_TOKEN, DASHBOARD_URL, ALLOWED_CHAT_ID } from './config.js'
import { createActionItem } from './action-items.js'
import { canSignReplay, signReplay } from './replay-signing.js'

export type PolicyValue = 'auto' | 'ask' | 'never'

export type ActionClass =
  | 'code.pr'
  | 'code.merge'
  | 'github.comment'
  | 'social.post'
  | 'email.send'
  | 'schedule.change'
  | 'spend.external'
  | 'paw.act'

export const DEFAULT_ACTION_POLICY: Record<string, PolicyValue> = {
  'code.pr': 'auto',
  // Merging is always a human decision (spec 6.1). code.pr stays auto so the
  // builder can open a pull request without parking a card; merge gets its own
  // class so that permission never rides along with it.
  'code.merge': 'ask',
  'github.comment': 'ask',
  'social.post': 'ask',
  'email.send': 'ask',
  'schedule.change': 'ask',
  'spend.external': 'ask',
  'paw.act': 'auto',
}

function isPolicyValue(v: unknown): v is PolicyValue {
  return v === 'auto' || v === 'ask' || v === 'never'
}

/**
 * Merged policy for one project. Unknown keys in the knob are kept so a new
 * action class can be gated before the code that names it ships; unknown
 * values are dropped back to the default for that class, or to ask.
 */
export function getActionPolicy(projectId: string): Record<string, PolicyValue> {
  const merged: Record<string, PolicyValue> = { ...DEFAULT_ACTION_POLICY }
  const raw = getKnob(projectId, 'action_policy', '')
  if (!raw) return merged
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const [k, v] of Object.entries(parsed)) {
      if (isPolicyValue(v)) merged[k] = v
      else if (!(k in merged)) merged[k] = 'ask'
    }
  } catch (err) {
    logger.warn({ err, projectId }, 'action_policy knob is not valid JSON, using defaults')
  }
  return merged
}

/** Policy for one class. Unknown class defaults to ask (spec 4.1). */
export function policyFor(projectId: string, actionClass: string): PolicyValue {
  return getActionPolicy(projectId)[actionClass] ?? 'ask'
}

export interface ActionAuditRow {
  id?: number
  ts_ms: number
  project_id: string
  actor: string
  action_class: string
  decision: 'allow' | 'pending' | 'deny'
  policy_value: PolicyValue
  ref_table: string | null
  ref_id: string | null
  payload_hash: string | null
}

export function hashPayload(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null
  try {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)
  } catch {
    return null
  }
}

/** One row per policy outcome. Never throws: an audit failure must not stop a decision. */
export function writeAudit(row: ActionAuditRow): number {
  let localId = 0
  try {
    const info = getDb().prepare(`
      INSERT INTO action_audit
        (ts_ms, project_id, actor, action_class, decision, policy_value, ref_table, ref_id, payload_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.ts_ms, row.project_id, row.actor, row.action_class,
      row.decision, row.policy_value, row.ref_table, row.ref_id, row.payload_hash,
    )
    localId = Number(info.lastInsertRowid)
  } catch (err) {
    logger.warn({ err, action_class: row.action_class }, 'action_audit write failed')
    return 0
  }
  void mirrorAuditToServer({ ...row, id: localId })
  return localId
}

async function mirrorAuditToServer(row: ActionAuditRow): Promise<void> {
  if (!DASHBOARD_URL) return
  const token = BOT_API_TOKEN || DASHBOARD_API_TOKEN
  if (!token) return
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/v1/internal/action-audit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-token': token },
      body: JSON.stringify({ rows: [{ ...row, bot_row_id: row.id }] }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) logger.debug({ status: res.status }, '[policy] action_audit server sync non-200')
  } catch (err) {
    logger.debug({ err }, '[policy] action_audit server sync failed')
  }
}

export type PolicyDecision = 'allow' | `pending:${string}` | 'deny'

export type PolicySender = (
  projectId: string,
  chatId: string,
  text: string,
  keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
) => Promise<void>

let policySender: PolicySender | null = null

/**
 * Register the Telegram keyboard sender. Called once from index.ts with the
 * live ChannelManager. CLI processes leave it unset: the card is still opened
 * and audited, only the push notification is skipped.
 */
export function setPolicySender(fn: PolicySender | null): void {
  policySender = fn
}

function cardTitle(actionClass: string, actor: string): string {
  return `Approve ${actionClass} requested by ${actor}`
}

interface ReplayPayload {
  argv: string[]
  cwd: string
}

function readReplay(payload: unknown): ReplayPayload | null {
  if (!payload || typeof payload !== 'object') return null
  const raw = (payload as { replay?: unknown }).replay as { argv?: unknown; cwd?: unknown } | undefined
  if (!raw || !Array.isArray(raw.argv) || raw.argv.length === 0) return null
  if (!raw.argv.every((a) => typeof a === 'string')) return null
  return { argv: raw.argv as string[], cwd: typeof raw.cwd === 'string' ? raw.cwd : '' }
}

/**
 * Returns the description to store when the payload carries a replay, or null
 * when there is nothing to rewrite. With no signing secret configured the
 * replay is dropped and the card says so, rather than storing a command the
 * runner would execute unverified.
 */
function signCardReplay(
  cardId: string,
  actionClass: string,
  actor: string,
  payload: unknown,
): string | null {
  const replay = readReplay(payload)
  if (!replay) return null

  const rest = { ...(payload as Record<string, unknown>) }
  delete rest.replay

  if (!canSignReplay()) {
    logger.warn({ cardId, actionClass }, 'no signing key, card recorded without a replay')
    return JSON.stringify({
      class: actionClass,
      actor,
      payload: {
        ...rest,
        replay_refused: 'no signing key configured (set CREDENTIAL_ENCRYPTION_KEY or WS_SECRET); this card cannot be replayed and must be done by hand',
      },
    }, null, 2)
  }

  const sig = signReplay(cardId, replay.argv, replay.cwd)
  return JSON.stringify({
    class: actionClass,
    actor,
    payload: { ...rest, replay: { argv: replay.argv, cwd: replay.cwd, sig } },
  }, null, 2)
}

/**
 * The one gate for agent side effects. Call it from the entry point that
 * performs the effect, never from prompt text.
 *
 *   allow            the caller proceeds
 *   pending:<cardId> the caller stops, the card runner resumes after a tap
 *   deny             the caller stops for good
 */
export async function checkAction(
  projectId: string,
  actionClass: string,
  actor: string,
  payload?: unknown,
): Promise<PolicyDecision> {
  const value = policyFor(projectId, actionClass)
  const ts = Date.now()
  const payload_hash = hashPayload(payload)

  if (value === 'auto') {
    writeAudit({ ts_ms: ts, project_id: projectId, actor, action_class: actionClass,
      decision: 'allow', policy_value: value, ref_table: null, ref_id: null, payload_hash })
    return 'allow'
  }

  if (value === 'never') {
    writeAudit({ ts_ms: ts, project_id: projectId, actor, action_class: actionClass,
      decision: 'deny', policy_value: value, ref_table: null, ref_id: null, payload_hash })
    logger.warn({ projectId, actionClass, actor }, 'policy refused an action')
    return 'deny'
  }

  // A CLI the card runner re-invoked carries the approved card id in its env.
  // Let it through instead of opening a second card for the same work: before
  // this, every approval tap produced another card and never the effect.
  const approvedCardId = process.env.POLICY_APPROVED_CARD
  if (approvedCardId) {
    const card = getActionItem(approvedCardId)
    if (card && (card.status === 'approved' || card.status === 'in_progress') && card.source === actionClass) {
      writeAudit({ ts_ms: ts, project_id: projectId, actor, action_class: actionClass,
        decision: 'allow', policy_value: value, ref_table: 'action_items', ref_id: approvedCardId, payload_hash })
      return 'allow'
    }
    logger.warn({ approvedCardId, actionClass }, 'POLICY_APPROVED_CARD does not match this action, opening a card')
  }

  const description = JSON.stringify({ class: actionClass, actor, payload: payload ?? null }, null, 2)
  const cardId = createActionItem({
    project_id: projectId,
    title: cardTitle(actionClass, actor),
    description,
    source: actionClass,
    proposed_by: actor,
    executable_by_agent: true,
    initial_status: 'proposed',
    priority: 'high',
  })

  // The signature covers the card id, so a replay lifted from one card cannot
  // be pasted onto another. The id only exists once the card does, which is
  // why the description is rewritten here rather than signed up front.
  const finalDescription = signCardReplay(cardId, actionClass, actor, payload)
  if (finalDescription !== null) updateActionItemFields(cardId, { description: finalDescription })

  writeAudit({ ts_ms: ts, project_id: projectId, actor, action_class: actionClass,
    decision: 'pending', policy_value: value, ref_table: 'action_items', ref_id: cardId, payload_hash })

  if (policySender && ALLOWED_CHAT_ID) {
    // Plain text only. No markdown, no HTML, no entity codes.
    const text = [
      `Approval needed: ${actionClass}`,
      `Project: ${projectId}`,
      `Requested by: ${actor}`,
      '',
      (finalDescription ?? description).length > 800
        ? `${(finalDescription ?? description).slice(0, 800)}...`
        : (finalDescription ?? description),
    ].join('\n')
    const keyboard = {
      inline_keyboard: [[
        { text: 'Approve', callback_data: `act:approve:${cardId}` },
        { text: 'Deny', callback_data: `act:deny:${cardId}` },
      ]],
    }
    try {
      await policySender(projectId, String(ALLOWED_CHAT_ID), text, keyboard)
    } catch (err) {
      logger.warn({ err, cardId }, 'policy approval card send failed, card is still open')
    }
  }

  return `pending:${cardId}`
}
