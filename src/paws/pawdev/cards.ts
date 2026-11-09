// src/paws/pawdev/cards.ts
//
// Mostly a pure mapping from triage findings to action_items rows: the
// handler does the writing, this file decides what should be written, so the
// decision is unit-testable and the two cannot drift. The one exception is
// observeRawForCycle, a read of the cycle's own stored state, shared by the
// triage and builder handlers so neither copies it.

import { getDb } from '../../db.js'
import type { CreateActionItemInput } from '../../action-items.js'
import type { RepoEventKind } from '../../repo-events.js'
import type { GithubDevRaw } from '../collectors/github-dev.js'

const EFFORTS = ['trivial', 'small', 'medium', 'large'] as const
const COLUMNS = ['proposed', 'approved'] as const

export interface TriageFinding {
  id: string
  severity: number
  title: string
  detail: string
  repo: string
  kind: string
  ref: string
  effort: (typeof EFFORTS)[number]
  proposed_column: (typeof COLUMNS)[number]
}

export interface CardPlan {
  input: CreateActionItemInput & { initial_status: 'proposed' | 'approved' }
  external_ref: string
  event: { repo: string; kind: RepoEventKind; ref: string; actor: string } | null
  /**
   * The Telegram text for a card that carries a public reply the owner has to
   * approve, or null when the card has nothing to post. The owner reads the
   * exact draft here before tapping, never just a button label (final review,
   * Important 12).
   */
  ask_text: string | null
}

/**
 * The reply body hidden in a card description, or the empty string. One home
 * for the regex: the triage handler shows this text to the owner and
 * executePawdevAction posts this text, so the two can never disagree.
 */
export function replyDraftFrom(description: string | null): string {
  const m = /REPLY DRAFT:[ \t]*([\s\S]*?)(?:\n\n|$)/.exec(description ?? '')
  return (m?.[1] ?? '').trim()
}

const ASK_DRAFT_CHARS = 300

export function externalRefFor(repo: string, ref: string): string {
  const n = String(ref).replace(/^#/, '')
  return `github:${repo}#${n}`
}

export function parseTriageFindings(analyzeText: string): TriageFinding[] {
  const cleaned = analyzeText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch { return [] }
  const list = (parsed as { findings?: unknown })?.findings
  if (!Array.isArray(list)) return []
  const out: TriageFinding[] = []
  for (const f of list as Array<Record<string, unknown>>) {
    const effort = String(f.effort ?? '')
    const column = String(f.proposed_column ?? '')
    if (!EFFORTS.includes(effort as never) || !COLUMNS.includes(column as never)) continue
    if (!f.repo || !f.ref || !f.title) continue
    out.push({
      id: String(f.id ?? `${f.repo}${f.ref}`),
      severity: Number(f.severity) || 1,
      title: String(f.title),
      detail: String(f.detail ?? ''),
      repo: String(f.repo),
      kind: String(f.kind ?? 'bug'),
      ref: String(f.ref),
      effort: effort as TriageFinding['effort'],
      proposed_column: column as TriageFinding['proposed_column'],
    })
  }
  return out
}

/**
 * Who filed the thing the finding points at, in repo_events actor form.
 * self is read from collector data, never from the LLM.
 */
function actorFor(finding: TriageFinding, raw: GithubDevRaw): { actor: string; self: boolean } {
  const repo = raw.repos.find(r => r.repo === finding.repo)
  const n = Number(String(finding.ref).replace(/^#/, ''))
  const issue = repo?.new_issues.find(i => i.number === n)
  const pr = repo?.new_prs.find(p => p.number === n)
  const item = issue ?? pr
  if (!item) return { actor: 'triage', self: false }
  return { actor: item.self ? 'triage' : `external:${item.author}`, self: item.self }
}

function eventKindFor(finding: TriageFinding, raw: GithubDevRaw): RepoEventKind | null {
  if (finding.kind === 'ci') return 'ci_failed'
  const repo = raw.repos.find(r => r.repo === finding.repo)
  const n = Number(String(finding.ref).replace(/^#/, ''))
  if (repo?.new_prs.some(p => p.number === n)) return 'pr_opened'
  if (repo?.new_issues.some(i => i.number === n)) return 'issue_opened'
  return null
}

/**
 * A finding is grounded only when its repo is one the collector actually
 * covered AND its ref points at a real item that repo produced: an issue, a
 * PR, or (for the two rollup kinds) a CI run or a nonzero dependabot count.
 * An ungrounded finding is the soul inventing something the collector never
 * saw, so it never becomes a card in any column.
 */
export function isGrounded(finding: TriageFinding, raw: GithubDevRaw): boolean {
  const repo = raw.repos.find(r => r.repo === finding.repo)
  if (!repo) return false
  const ref = String(finding.ref)
  // A ref padded with whitespace or a newline is not the clean "#42" the
  // collector produces; treat it as ungrounded rather than trimming it away
  // and matching a number the soul never actually named. Trimming first
  // would let "3 " or "\n3" through, since trim() removes exactly the
  // padding that makes them suspect.
  if (!/^#?\d+$/.test(ref)) return false
  const n = Number(ref.replace(/^#/, ''))
  if (repo.new_issues.some(i => i.number === n)) return true
  if (repo.new_prs.some(p => p.number === n)) return true
  if (finding.kind === 'ci' && (repo.ci.conclusion !== null || repo.ci.workflow !== null)) return true
  if (finding.kind === 'dependabot' && typeof repo.dependabot_open === 'number' && repo.dependabot_open > 0) return true
  return false
}

export function planCards(findings: TriageFinding[], raw: GithubDevRaw, existingRefs: Set<string>): CardPlan[] {
  const plans: CardPlan[] = []
  const seen = new Set(existingRefs)
  for (const f of findings) {
    if (f.kind === 'noise') continue
    if (!isGrounded(f, raw)) continue
    const external_ref = externalRefFor(f.repo, f.ref)
    if (seen.has(external_ref)) continue
    seen.add(external_ref)

    const { actor, self } = actorFor(f, raw)
    // Spec 6.4: a self-filed item never advances past Triaged, and only
    // trivial or small work is ever queued for the builder.
    const sizeOk = f.effort === 'trivial' || f.effort === 'small'
    const status: 'proposed' | 'approved' =
      f.proposed_column === 'approved' && sizeOk && !self ? 'approved' : 'proposed'

    const description = [
      f.detail,
      '',
      `repo ${f.repo}`,
      `ref ${f.ref}`,
      `kind ${f.kind}`,
      `effort ${f.effort}`,
      self ? 'self filed, stays in Triaged' : `filed by ${actor.replace('external:', '')}`,
    ].join('\n')

    const draft = replyDraftFrom(description)
    plans.push({
      external_ref,
      ask_text: draft
        ? `${f.repo}${f.ref}: ${f.title}\n\nDraft reply:\n${draft.slice(0, ASK_DRAFT_CHARS)}`
        : null,
      input: {
        project_id: 'pawdev',
        title: `${f.repo}${f.ref} ${f.title}`.slice(0, 200),
        description,
        priority: f.severity >= 4 ? 'high' : f.severity >= 3 ? 'medium' : 'low',
        source: `github:${f.repo}`,
        proposed_by: 'triage',
        executable_by_agent: status === 'approved',
        initial_status: status,
      },
      event: (() => {
        const kind = eventKindFor(f, raw)
        return kind ? { repo: f.repo, kind, ref: f.ref, actor } : null
      })(),
    })
  }
  return plans
}

/**
 * The collector payload the routine stored on this cycle, or null when there
 * is none (a cycle that ran before the collector, or a lookup failure).
 * Shared by the triage and builder handlers, both post-ANALYZE and post-ACT,
 * so the parsing of paw_cycles.state lives in exactly one place.
 */
export function observeRawForCycle(cycleId: string): GithubDevRaw | null {
  try {
    const row = getDb().prepare('SELECT state FROM paw_cycles WHERE id = ?').get(cycleId) as { state: string } | undefined
    if (!row) return null
    const state = JSON.parse(row.state) as { observe_raw?: string | null }
    if (!state.observe_raw) return null
    return (JSON.parse(state.observe_raw) as { raw_data?: GithubDevRaw }).raw_data ?? null
  } catch {
    return null
  }
}
