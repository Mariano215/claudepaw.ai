// src/paws/pawdev/actions.ts
//
// The four irreversible steps: merge, public reply, mirror regeneration and
// issue close. Each is a button on the routine's approval card. The routine
// never performs them on its own; a person taps the button, and that tap is
// the approval (rulings.md B3). Policy is still consulted so a knob set to
// never blocks the step outright, and one audit row records the tap. gh runs
// directly with an argv array, never through scripts/gh-wrapper.sh, which is
// for agent-initiated calls only.

import { transitionActionItem } from '../../action-items.js'
import { updateActionItemFields, getKnob } from '../../db.js'
import { writeRepoEvent } from '../../repo-events.js'
import { policyFor, writeAudit } from '../../policy.js'
import { pawdevGhEnv } from '../handlers/pawdev-builder.js'
import { DEFAULT_PAWDEV_REPOS, parseRepoList } from '../collectors/github-dev.js'
import { SYNC_SCRIPT } from './reviewer.js'
import { replyDraftFrom } from './cards.js'
import { pawDevCycleSeed } from './paw-def.js'
import { PROJECT_ROOT } from '../../config.js'
import { logger } from '../../logger.js'
import type { InlineKeyboardButton, PawSender } from '../types.js'
import type { ShellRunner } from '../handlers/pawdev-builder.js'

// Registered once from index.ts to the exact PawSender the routine's own
// cycle approval uses (src/index.ts pawSendFn), so the builder's merge card
// goes out through the same ChannelManager path, never a second one
// (rulings.md Task 9 fix round 1, item 1).
let cardSender: PawSender | null = null
export function setPawdevCardSender(fn: PawSender | null): void { cardSender = fn }
export function getPawdevCardSender(): PawSender | null { return cardSender }

export type PawdevAction = 'reply' | 'merge' | 'mirror' | 'close'

/** The callback data is a string off the wire. Nothing else may reach the switch. */
export function isPawdevAction(s: string): s is PawdevAction {
  return s === 'reply' || s === 'merge' || s === 'mirror' || s === 'close'
}

export const PAWDEV_ACTION_LABELS: Record<PawdevAction, string> = {
  reply: 'Post reply',
  merge: 'Merge',
  mirror: 'Regenerate mirror',
  close: 'Close issue',
}

const ACTION_CLASS: Record<PawdevAction, string> = {
  reply: 'github.comment',
  merge: 'code.merge',
  mirror: 'code.pr',
  close: 'github.comment',
}

export interface AskCard {
  id: string
  title: string
  description: string | null
  external_ref: string | null
  status: string
  created_at: number
  /** When the builder last wrote to the card, which is when its ask went out. */
  last_run_at: number | null
}

export interface ActionDeps {
  sh: ShellRunner
  card: (id: string) => AskCard | null
}

export function pawdevApprovalRows(cardIds: string[]): InlineKeyboardButton[][] {
  const id = cardIds[0]
  if (!id) return []
  return [
    [
      { text: PAWDEV_ACTION_LABELS.reply, callback_data: `pawdev:reply:${id}` },
      { text: PAWDEV_ACTION_LABELS.merge, callback_data: `pawdev:merge:${id}` },
    ],
    [
      { text: PAWDEV_ACTION_LABELS.mirror, callback_data: `pawdev:mirror:${id}` },
      { text: PAWDEV_ACTION_LABELS.close, callback_data: `pawdev:close:${id}` },
    ],
  ]
}

/** Same clock the routine's own approval uses, so one timeout governs both. */
export function isAskExpired(requestedAtMs: number | null, timeoutSec: number, now: number): boolean {
  if (!requestedAtMs) return false
  return now - requestedAtMs > timeoutSec * 1000
}

/**
 * A button months old still fires otherwise: the card stays `blocked`, so the
 * double-tap guard never sees it (final review, Minor 14). The ask went out
 * when the card was last written, or when it was opened.
 */
function askExpired(card: AskCard): boolean {
  return isAskExpired(card.last_run_at ?? card.created_at ?? null, pawDevCycleSeed.approval_timeout_sec, Date.now())
}

function parts(card: AskCard): { repo: string; issue: string; pr: string } {
  let ref: { issue?: string; pr?: string } = {}
  try { ref = JSON.parse(card.external_ref ?? '{}') as typeof ref } catch { /* prose, not JSON */ }
  const m = /^github:([^#]+)#(\d+)$/.exec(ref.issue ?? '')
  return { repo: m?.[1] ?? '', issue: m?.[2] ?? '', pr: ref.pr ?? '' }
}

function allowedRepos(): string[] {
  return parseRepoList(String(getKnob('pawdev', 'repos', DEFAULT_PAWDEV_REPOS.join(','))))
}

/** A positive integer straight off a regex match; empty string when it is not one. */
function positiveInt(s: string): string {
  return /^[1-9][0-9]*$/.test(s) ? s : ''
}

export async function executePawdevAction(
  action: PawdevAction,
  cardId: string,
  deps: ActionDeps,
): Promise<{ ok: boolean; message: string }> {
  const card = deps.card(cardId)
  if (!card) return { ok: false, message: `card ${cardId} not found` }

  // A second tap on the same button, or a tap after the card already moved
  // on, must do nothing: not another gh call, not another audit row.
  if (card.status !== 'blocked') {
    return { ok: false, message: 'already handled' }
  }

  if (askExpired(card)) {
    return { ok: false, message: 'this ask expired' }
  }

  const actionClass = ACTION_CLASS[action]
  const policyValue = policyFor('pawdev', actionClass)
  if (policyValue === 'never') {
    return { ok: false, message: `policy is never for ${actionClass}, refusing` }
  }

  const { repo, issue, pr } = parts(card)
  if (!repo || !allowedRepos().includes(repo)) {
    return { ok: false, message: `repo not configured for pawdev: ${repo || '(none)'}` }
  }
  const prNumber = positiveInt(/\/pull\/(\d+)/.exec(pr)?.[1] ?? '')
  const issueNumber = positiveInt(issue)

  // The human tap is the approval. One audit row records it; nothing here
  // opens a second card the way policy.ts's own checkAction would.
  writeAudit({
    ts_ms: Date.now(), project_id: 'pawdev', actor: 'human', action_class: actionClass,
    decision: 'allow', policy_value: policyValue, ref_table: 'action_items', ref_id: cardId, payload_hash: null,
  })

  let result: { code: number; stdout: string; stderr: string }
  switch (action) {
    case 'merge': {
      if (!prNumber) return { ok: false, message: 'card has no pull request url' }
      result = await deps.sh('gh', ['pr', 'merge', prNumber, '-R', repo, '--squash', '--delete-branch'], undefined, pawdevGhEnv())
      break
    }
    case 'reply': {
      if (!issueNumber) return { ok: false, message: 'card has no issue reference' }
      // The triage soul's own draft, the same text the ask message showed the
      // owner, never text a caller supplies.
      const body = replyDraftFrom(card.description)
      if (!body) return { ok: false, message: 'card has no REPLY DRAFT to post' }
      result = await deps.sh('gh', ['issue', 'comment', issueNumber, '-R', repo, '--body', body], undefined, pawdevGhEnv())
      break
    }
    case 'close': {
      if (!issueNumber) return { ok: false, message: 'card has no issue reference' }
      result = await deps.sh('gh', ['issue', 'close', issueNumber, '-R', repo], undefined, pawdevGhEnv())
      break
    }
    case 'mirror': {
      const script = SYNC_SCRIPT[repo]
      if (!script) return { ok: false, message: `${repo} is not a mirror` }
      const [cmd, ...args] = script.split(' ')
      result = await deps.sh(cmd, args, PROJECT_ROOT)
      break
    }
  }

  if (result.code !== 0) {
    const msg = (result.stderr || result.stdout || `exit ${result.code}`).slice(0, 500)
    logger.warn({ action, cardId, code: result.code }, '[pawdev] ask step failed')
    updateActionItemFields(cardId, { last_run_at: Date.now(), last_run_result: `${action} failed: ${msg}` })
    return { ok: false, message: msg }
  }

  const kind = action === 'merge' ? 'pr_merged'
    : action === 'reply' ? 'reply_posted'
    : action === 'close' ? 'issue_closed'
    : 'mirror_synced'
  writeRepoEvent({ repo, kind, ref: action === 'merge' ? pr : `#${issue}`, actor: 'human', item_id: cardId })

  // One action per card, all four of them. Moving the card off `blocked` is
  // what makes the guard at the top of this function a real double-tap guard:
  // before this, reply and mirror stayed blocked, so a second tap posted a
  // second public comment or ran a second sync (final review, Important 7).
  // blocked -> completed is illegal; go through in_progress first (rulings.md B4).
  transitionActionItem(cardId, 'in_progress', 'human')
  transitionActionItem(cardId, 'completed', 'human')
  updateActionItemFields(cardId, { last_run_at: Date.now(), last_run_result: `${action} done` })
  return { ok: true, message: `${PAWDEV_ACTION_LABELS[action]} done on ${repo}` }
}
