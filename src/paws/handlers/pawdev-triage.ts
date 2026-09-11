// src/paws/handlers/pawdev-triage.ts
//
// Runs after the ANALYZE phase of paw-dev-cycle. The triage soul emits JSON;
// this file turns it into action_items rows and repo_events. Deterministic on
// purpose: an agent with no real tool access cannot be trusted to write rows.

import { createActionItem, transitionActionItem } from '../../action-items.js'
import { listActionItems, updateActionItemFields } from '../../db.js'
import { writeRepoEvent } from '../../repo-events.js'
import { logger } from '../../logger.js'
import { parseTriageFindings, planCards, isGrounded, externalRefFor, observeRawForCycle } from '../pawdev/cards.js'
import { realShell, pawdevGhEnv } from './pawdev-builder.js'
import { contributorPrs, buildReviewerPrompt, buildPortInstructions, coauthorTrailer, isValidCoauthor } from '../pawdev/reviewer.js'
import { getPaw } from '../db.js'
import { getDb } from '../../db.js'
import type { DevPr } from '../collectors/github-dev.js'
import type { PostActHandler } from './index.js'

// One full reviewer agent runs per contributor pull request, each carrying up
// to 60 KB of diff. On the first cycle the watermark is 0, so every open pull
// request on every mirror is new: without a cap that is up to 150 model calls
// in one cycle. The rest are still in the collector payload next cycle.
const MAX_REVIEWS_PER_CYCLE = 3

// One Telegram message per card that carries a public reply. Capped so a busy
// cycle cannot flood the chat; the rest wait for the next cycle.
const MAX_ASKS_PER_CYCLE = 5

async function ghDiff(repo: string, number: number): Promise<string> {
  const r = await realShell('gh', ['pr', 'diff', String(number), '-R', repo], undefined, pawdevGhEnv())
  return r.code === 0 ? r.stdout : `[diff unavailable: ${(r.stderr || r.stdout).trim() || 'unknown error'}]`
}

async function runReviewerAgent(prompt: string): Promise<string> {
  const { runAgent } = await import('../../agent.js')
  const { getSoul, buildAgentPrompt } = await import('../../souls.js')
  const soul = getSoul('pawdev--reviewer', 'pawdev')
  const full = soul ? `${buildAgentPrompt(soul, 'pawdev')}\n\n---\n\n${prompt}` : prompt
  const res = await runAgent(full, undefined, undefined, undefined, undefined,
    { projectId: 'pawdev', source: 'reviewer' }, { projectId: 'pawdev', agentId: 'pawdev--reviewer' })
  return res.text ?? ''
}

export async function openPortCard(repo: string, pr: DevPr, existing: Set<string>): Promise<void> {
  const ref = externalRefFor(repo, `#${pr.number}`)
  if (existing.has(ref)) return

  const diff = await ghDiff(repo, pr.number)
  let verdict: { verdict?: string; leaks?: string[]; notes?: string; coauthor?: string } = {}
  try {
    verdict = JSON.parse(await runReviewerAgent(buildReviewerPrompt(repo, pr, diff))) as typeof verdict
  } catch {
    verdict = { verdict: 'port', notes: 'reviewer returned no JSON, defaulting to a port card' }
  }

  const coauthor = verdict.coauthor && isValidCoauthor(verdict.coauthor) ? verdict.coauthor : coauthorTrailer(pr.author)
  const description = [
    verdict.notes ?? '',
    verdict.leaks?.length ? `\nLEAKS FOUND:\n${verdict.leaks.join('\n')}` : '',
    '',
    `repo ${repo}`,
    `ref #${pr.number}`,
    'kind contributor_pr',
    'effort medium',
    '',
    'Port steps:',
    ...buildPortInstructions(repo, pr, coauthor),
  ].join('\n')

  const id = createActionItem({
    project_id: 'pawdev',
    title: `${repo}#${pr.number} port ${pr.title}`.slice(0, 200),
    description,
    priority: 'high',
    source: `github:${repo}`,
    proposed_by: 'reviewer',
    executable_by_agent: false,
    initial_status: 'proposed',
  })
  updateActionItemFields(id, { external_ref: JSON.stringify({ issue: ref, pr: `https://github.com/${repo}/pull/${pr.number}` }) })
  writeRepoEvent({ repo, kind: 'pr_opened', ref: `#${pr.number}`, actor: `external:${pr.author}`, item_id: id })
  existing.add(ref)
}

export const pawdevTriageHandler: PostActHandler = async (cycleId, pawId, projectId, analyzeText) => {
  const raw = observeRawForCycle(cycleId)
  if (!raw) {
    logger.warn({ cycleId }, '[pawdev] no collector payload on the cycle, no cards opened')
    return
  }

  const findings = parseTriageFindings(analyzeText)

  const existing = new Set<string>()
  // includeArchived on purpose: archiving a card must not let the same issue
  // open a fresh duplicate next cycle (final review, Minor 20).
  for (const item of listActionItems({ projectId: 'pawdev', includeArchived: true }) as Array<{ external_ref: string | null }>) {
    if (!item.external_ref) continue
    try { existing.add((JSON.parse(item.external_ref) as { issue?: string }).issue ?? '') }
    catch { existing.add(item.external_ref) }
  }
  existing.delete('')

  const plans = planCards(findings, raw, existing)
  const asks: Array<{ id: string; text: string }> = []
  let asksSkippedApproved = 0
  for (const plan of plans) {
    const id = createActionItem(plan.input)
    updateActionItemFields(id, { external_ref: JSON.stringify({ issue: plan.external_ref }) })
    // Without this the port-card loop below opens a second card for the same
    // pull request: planCards dedupes against its own copy of the set, not
    // this one (final review, Important 5).
    existing.add(plan.external_ref)
    if (plan.event) {
      writeRepoEvent({ ...plan.event, item_id: id })
    }
    // Only a proposed card becomes an ask. An approved one is already queued
    // for the builder, which reads status `approved` only, so moving it to
    // blocked here would mean it is never built (re-review 2, New Breakage 1).
    // It gets its ask on a later cycle, once the build has completed it.
    if (plan.ask_text) {
      if (plan.input.initial_status === 'proposed') asks.push({ id, text: plan.ask_text })
      else asksSkippedApproved++
    }
  }

  // Contributor pull requests on a mirror get their own card with the port
  // instructions already written. Nothing here merges anything.
  const contributors = contributorPrs(raw)
    .sort((a, b) => a.pr.createdAt.localeCompare(b.pr.createdAt))
  for (const { repo, pr } of contributors.slice(0, MAX_REVIEWS_PER_CYCLE)) {
    await openPortCard(repo, pr, existing)
  }

  const asksSent = await sendAsks(pawId, projectId, asks.slice(0, MAX_ASKS_PER_CYCLE))

  const droppedUngrounded = findings.filter(f => f.kind !== 'noise' && !isGrounded(f, raw)).length
  logger.info(
    {
      cycleId, projectId, opened: plans.length, findings: findings.length,
      dropped_ungrounded: droppedUngrounded,
      reviewer_deferred: Math.max(0, contributors.length - MAX_REVIEWS_PER_CYCLE),
      asks_deferred: Math.max(0, asks.length - asksSent),
      asks_skipped_approved: asksSkippedApproved,
    },
    '[pawdev] triage cards opened',
  )
}

/**
 * One plain-text message per card that carries a public reply, through the
 * same PawSender the builder's merge card uses, so every outbound message
 * still leaves through ChannelManager. Returns how many went out.
 */
async function sendAsks(pawId: string, projectId: string, asks: Array<{ id: string; text: string }>): Promise<number> {
  if (asks.length === 0) return 0
  const { getPawdevCardSender, pawdevApprovalRows } = await import('../pawdev/actions.js')
  const sender = getPawdevCardSender()
  const paw = getPaw(getDb(), pawId)
  if (!sender || !paw) {
    logger.warn({ pawId, asks: asks.length }, '[pawdev] no card sender or paw, reply asks not sent')
    return 0
  }
  let sent = 0
  for (const ask of asks) {
    try {
      // executePawdevAction only acts on a card that is `blocked`, so a button
      // on a card in any other status is dead on arrival (re-review, New
      // Breakage 1). Every card here is proposed, and proposed to blocked is
      // an illegal transition, so it goes through approved first.
      transitionActionItem(ask.id, 'approved', 'triage')
      transitionActionItem(ask.id, 'blocked', 'triage')
      updateActionItemFields(ask.id, { last_run_at: Date.now(), last_run_result: 'awaiting: reply' })
      await sender(paw.config.chat_id, ask.text, { inline_keyboard: pawdevApprovalRows([ask.id]) }, projectId)
      sent++
    } catch (err) {
      logger.warn({ err, cardId: ask.id }, '[pawdev] reply ask send failed, the card is still open')
    }
  }
  return sent
}
