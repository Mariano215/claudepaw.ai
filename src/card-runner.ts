// The executor for approved, agent-executable cards.
//
// Without this the `ask` branch of the policy layer parks work forever: the
// local DB held 1160 proposed and 24 approved action items with zero
// in_progress or completed rows before this shipped
// (.reviews/loop1-autonomy.md, A2).
//
// Concurrency is one card per project per tick so a slow agent cannot stack
// runs, and so a bad card cannot starve every other project.
import { execFile } from 'node:child_process'
import { listActionItems, updateActionItemFields } from './db.js'
import { transitionActionItem } from './action-items.js'
import { logger } from './logger.js'
import { recordError } from './telemetry.js'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { getKnownCliNames } from './sdk-permissions.js'
import { verifyReplaySignature, type CardReplay } from './replay-signing.js'
import { buildAgentEnv, CLAUDE_DESKTOP_TIMEOUT_MS } from './agent-runtime.js'

export type RunAgentFn = (
  prompt: string,
  ctx: { projectId: string; source: string },
) => Promise<{ text: string | null }>

export type RunReplayFn = (
  argv: string[],
  ctx: { cardId: string; cwd: string; env: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>

const REPLAY_TIMEOUT_MS = 10 * 60 * 1000

// The command must be one of this repo's own CLIs, matched the same way the
// Bash allowlist matches `node dist/<name>-cli.js`: a built file whose
// src/<name>-cli.ts twin exists. A dist file an agent wrote has no twin.
const DIST_CLI_RE = /^(?:.*\/)?dist\/([A-Za-z0-9._-]+-cli)\.js$/

// Node flags that turn `node <file>` into `node <arbitrary code>`. None of
// them can appear in a CLI invocation this bot mints, so any of them in a
// recorded argv means the row was written by something else.
const FORBIDDEN_NODE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '--import', '-r', '--require', '--loader'])

/**
 * Why this replay may not be executed, or null when it may. Order matters:
 * shape first, then the signature, so a malformed argv is never fed to the
 * HMAC.
 */
function replayProblem(cardId: string, replay: CardReplay): string | null {
  if (replay.argv.some((tok) => tok.includes('\n') || tok.includes('\0'))) {
    return 'replay argv contains a control character'
  }
  if (replay.argv.some((tok) => FORBIDDEN_NODE_FLAGS.has(tok))) {
    return 'replay argv contains a node eval flag'
  }
  const first = replay.argv[0] ?? ''
  const m = DIST_CLI_RE.exec(first)
  if (first.startsWith('-') || !m || !getKnownCliNames().has(m[1]!)) {
    return 'replay argv does not name a known CLI'
  }
  // The cwd is signed, so a mismatch is either tampering or a CLI invoked from
  // somewhere else. Either way the child runs from the repo or not at all.
  if (replay.cwd && resolve(replay.cwd) !== resolve(PROJECT_ROOT)) return 'replay cwd not allowed'
  if (!verifyReplaySignature(cardId, replay)) return 'replay signature invalid'
  return null
}

// An agent must say so explicitly. Before this any non-empty reply counted as
// success, so a card the runner could not do at all (a file edit, which the
// default deny list refuses) shipped as completed on the strength of a polite
// refusal.
const DONE_RE = /^DONE:/m

function parseReplay(description: string | null | undefined): CardReplay | null {
  if (!description) return null
  try {
    const parsed = JSON.parse(description) as { payload?: { replay?: unknown } }
    const raw = parsed?.payload?.replay as { argv?: unknown; cwd?: unknown; sig?: unknown } | undefined
    if (!raw || !Array.isArray(raw.argv) || raw.argv.length === 0) return null
    if (!raw.argv.every((a) => typeof a === 'string')) return null
    return {
      argv: raw.argv as string[],
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      sig: typeof raw.sig === 'string' ? raw.sig : undefined,
    }
  } catch {
    return null
  }
}

const defaultReplayRunner: RunReplayFn = (argv, ctx) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      argv,
      { cwd: ctx.cwd, env: ctx.env, timeout: REPLAY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as unknown as { code: number }).code
          : err ? 1 : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })

const inFlight = new Set<string>()

// A card can be left in_progress by a crash or restart, since inFlight is
// in-memory and does not survive the process. Anything stuck twice as long
// as one agent run is allowed to take gets reaped back to blocked so it
// re-enters the queue instead of parking forever.
const REAP_REASON = 'runner did not finish (restart)'
const REAP_AFTER_MS = 2 * CLAUDE_DESKTOP_TIMEOUT_MS

function reapStuckInProgress(): void {
  const cutoff = Date.now() - REAP_AFTER_MS
  const stuck = listActionItems({ status: 'in_progress' })
    .filter(i => !inFlight.has(i.project_id) && i.updated_at < cutoff)
  for (const item of stuck) {
    try {
      updateActionItemFields(item.id, { last_run_result: REAP_REASON })
      transitionActionItem(item.id, 'blocked', REAP_REASON)
    } catch (err) {
      logger.warn({ err, cardId: item.id }, 'reap stuck card skip')
    }
  }
}

/** ponytail: one card per project per tick. Raise only if the queue backs up. */
export async function runApprovedCards(
  runAgentFn?: RunAgentFn,
  runReplayFn?: RunReplayFn,
): Promise<{ started: number; completed: number; blocked: number }> {
  reapStuckInProgress()
  const run = runAgentFn ?? defaultRunner
  const replayRun = runReplayFn ?? defaultReplayRunner
  // Paw Dev cards are built by src/paws/handlers/pawdev-builder.ts, which is
  // the only runner that gives them a sandboxed worktree. This generic runner
  // would otherwise take them first and run untrusted issue text as a free
  // prompt in the live checkout.
  const approved = listActionItems({ status: 'approved' })
    .filter(i => i.executable_by_agent === 1 && i.project_id !== 'pawdev')

  const perProject = new Map<string, typeof approved[number]>()
  for (const item of approved) {
    if (inFlight.has(item.project_id)) continue
    if (!perProject.has(item.project_id)) perProject.set(item.project_id, item)
  }

  let started = 0, completed = 0, blocked = 0
  for (const item of perProject.values()) {
    inFlight.add(item.project_id)
    started++
    const startedAt = Date.now()
    try {
      transitionActionItem(item.id, 'in_progress', 'card-runner')

      const replay = parseReplay(item.description)
      if (replay) {
        // The description is an editable row. Anything that does not verify is
        // treated as tampering and never reaches exec.
        const problem = replayProblem(item.id, replay)
        if (problem) {
          updateActionItemFields(item.id, { last_run_at: startedAt, last_run_result: problem })
          recordError('card-runner', 'warn', `${problem} (card ${item.id})`, undefined, {
            cardId: item.id,
            projectId: item.project_id,
          })
          transitionActionItem(item.id, 'blocked', 'card-runner')
          blocked++
          continue
        }

        // Re-run the exact command the CLI was invoked with. The env var lets
        // checkAction recognise this as the approved work rather than a fresh
        // request, so it does not park another card.
        const out = await replayRun(replay.argv, {
          cardId: item.id,
          cwd: PROJECT_ROOT,
          // The filtered agent env, not the bot's own. The CLIs read their
          // credentials from .env through src/config.js, so they keep working
          // without the child inheriting the bot's tokens.
          env: buildAgentEnv({ POLICY_APPROVED_CARD: item.id }),
        })
        const ok = out.code === 0
        const detail = (ok ? out.stdout : out.stderr || out.stdout).trim()
        updateActionItemFields(item.id, {
          last_run_at: startedAt,
          last_run_result: detail.slice(-2000) || `replay exited ${out.code}`,
        })
        transitionActionItem(item.id, ok ? 'completed' : 'blocked', 'card-runner')
        if (ok) completed++
        else blocked++
        continue
      }

      const prompt = [
        'Carry out this approved work item and report what you did.',
        '',
        `Title: ${item.title}`,
        item.description ? `Details:\n${item.description}` : '',
        '',
        'End your reply with a line of the form DONE: <one sentence summary> if',
        'you finished it, or BLOCKED: <reason> if you could not. Anything else',
        'is treated as not finished.',
      ].filter(Boolean).join('\n')

      const res = await run(prompt, { projectId: item.project_id, source: 'card-runner' })
      const text = res.text?.trim() ?? ''
      const done = DONE_RE.test(text)
      updateActionItemFields(item.id, {
        last_run_at: startedAt,
        last_run_result: (done ? text.slice(0, 2000) : text.slice(0, 200)) || 'agent returned no text',
      })
      if (done) {
        transitionActionItem(item.id, 'completed', 'card-runner')
        completed++
      } else {
        transitionActionItem(item.id, 'blocked', 'card-runner')
        blocked++
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      updateActionItemFields(item.id, { last_run_at: startedAt, last_run_result: msg.slice(0, 2000) })
      try { transitionActionItem(item.id, 'blocked', 'card-runner') } catch { /* already moved */ }
      blocked++
      logger.error({ err, cardId: item.id }, 'card runner failed')
    } finally {
      inFlight.delete(item.project_id)
    }
  }

  if (started > 0) logger.info({ started, completed, blocked }, 'card runner tick')
  return { started, completed, blocked }
}

async function defaultRunner(prompt: string, ctx: { projectId: string; source: string }): Promise<{ text: string | null }> {
  const { runAgent } = await import('./agent.js')
  // actionPlan is left undefined (not the ctx object) on purpose: an
  // executing card must never ingest new action items from its own output.
  const res = await runAgent(prompt, undefined, undefined, true, undefined,
    undefined, { projectId: ctx.projectId })
  return { text: res.text }
}

/**
 * One-time backlog pass. Proposed cards older than the window are closed as
 * rejected: nobody is going to answer a two month old request, and leaving
 * them makes the Needs you queue useless.
 */
export function triageStaleCards(olderThanMs: number = 60 * 86_400_000): number {
  const cutoff = Date.now() - olderThanMs
  const stale = listActionItems({ status: 'proposed' }).filter(i => i.created_at < cutoff)
  let n = 0
  for (const item of stale) {
    try {
      transitionActionItem(item.id, 'rejected', 'stale-triage')
      n++
    } catch (err) {
      logger.warn({ err, cardId: item.id }, 'stale triage skip')
    }
  }
  logger.info({ rejected: n, olderThanMs }, 'stale card triage complete')
  return n
}
