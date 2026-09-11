// src/paws/handlers/pawdev-builder.ts
//
// The ACT phase of paw-dev-cycle. One approved card, sized trivial or small,
// becomes one branch, one tested change and one pull request. Everything the
// agent cannot be trusted to do is done here in TypeScript: git, the test run,
// the leak scan and the pull request all go through a shell runner, and the
// pull request goes through scripts/gh-wrapper.sh so the policy layer sees it.
//
// The builder never commits in the live checkout. It works inside a git
// worktree under .worktrees/pawdev-<card.id>, on its own branch, and refuses
// the card outright if the live checkout is dirty before it starts. The agent
// itself edits inside that worktree too (runtimeContext.workRoot, fix round
// 1 Critical 1): src/sdk-permissions.ts scopes every write-tool path check to
// that directory once it is set.
//
// The card ends on `blocked`, which the board renders as "Needs you". That is
// deliberate: merge is always an ask step (spec 6.1), so a card with an open
// pull request is waiting on a person, not on the routine.

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { getDb, listActionItems, updateActionItemFields } from '../../db.js'
import { transitionActionItem } from '../../action-items.js'
import { writeRepoEvent, listRepoEvents, repoEventStats } from '../../repo-events.js'
import { getCredential } from '../../credentials.js'
import { PROJECT_ROOT } from '../../config.js'
import { logger } from '../../logger.js'
import { getPaw } from '../db.js'
import { observeRawForCycle } from '../pawdev/cards.js'
import { repoLines, renderReport, renderHistoryMarkdown, writeHistoryFile } from '../pawdev/report.js'
import type { PostActHandler } from './index.js'
import type { PawSender } from '../types.js'

export interface BuilderCard {
  id: string
  title: string
  description: string | null
  external_ref: string | null
  status: string
}

export interface ShellRunner {
  (cmd: string, args: string[], cwd?: string, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }>
}

export function cardEffort(description: string | null): 'trivial' | 'small' | 'medium' | 'large' | 'unknown' {
  const m = /^effort (trivial|small|medium|large)$/m.exec(description ?? '')
  return (m?.[1] as 'trivial' | 'small' | 'medium' | 'large') ?? 'unknown'
}

/** At most one card per cycle. Smaller work first, so a cycle is cheap. */
export function pickBuildableCard(cards: BuilderCard[]): BuilderCard | null {
  const buildable = cards.filter(c => {
    const e = cardEffort(c.description)
    return e === 'trivial' || e === 'small'
  })
  if (buildable.length === 0) return null
  buildable.sort((a, b) => {
    const rank = (c: BuilderCard) => (cardEffort(c.description) === 'trivial' ? 1 : 0)
    return rank(b) - rank(a) || a.id.localeCompare(b.id)
  })
  return buildable[0]
}

function refFields(card: BuilderCard): { repo: string; ref: string; issue: string } {
  let issue = ''
  try { issue = (JSON.parse(card.external_ref ?? '{}') as { issue?: string }).issue ?? '' } catch { issue = card.external_ref ?? '' }
  const m = /^github:([^#]+)#(\d+)$/.exec(issue)
  return { repo: m?.[1] ?? '', ref: m ? `#${m[2]}` : '', issue }
}

export function branchNameFor(card: BuilderCard): string {
  const { ref } = refFields(card)
  const withoutPrefix = card.title.replace(/^\S+#\d+\s*/, '')
  const slug = withoutPrefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  // A title with no ASCII letters or digits slugs to '', which would name the
  // branch fix/-42. Fall back to the card id so the name still says something.
  const safeSlug = slug || card.id
  return `fix/${safeSlug}-${ref.replace('#', '') || '0'}`
}

// Absolute, so every `sh` call that takes it as cwd works whatever
// process.cwd() happens to be. A relative path here was the condition item 18
// was raised for (re-review, New Breakage 3).
function worktreeDirFor(card: BuilderCard): string {
  return join(PROJECT_ROOT, '.worktrees', `pawdev-${card.id}`)
}

// Important 1 plus the automated HIGH finding: `changed_files` comes from LLM
// output shaped by untrusted GitHub issue text, and it is spread straight
// into both `npx vitest related --run` and `git add --`. Reject anything that
// is not a plain relative path inside the worktree, that could smuggle a flag
// into vitest, or that names a file whose contents control what typecheck or
// the test run executes.
const CHANGED_FILE_RE = /^[A-Za-z0-9._/-]+$/
const CHANGED_FILE_FORBIDDEN_FIRST_SEGMENTS = new Set(['.git', 'store', 'scripts', 'dist', 'node_modules'])
const CHANGED_FILE_FORBIDDEN_BASENAMES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])

function invalidChangedFile(file: string): string | null {
  if (!CHANGED_FILE_RE.test(file)) return `disallowed characters: ${file}`
  if (file.startsWith('-')) return `looks like a flag: ${file}`
  if (file.startsWith('/')) return `absolute path not allowed: ${file}`
  const segments = file.split('/')
  if (segments.includes('..') || segments.includes('.')) return `path traversal: ${file}`
  const first = segments[0] ?? ''
  if (CHANGED_FILE_FORBIDDEN_FIRST_SEGMENTS.has(first) || first.startsWith('.env')) return `forbidden path: ${file}`
  const base = segments[segments.length - 1] ?? ''
  if (CHANGED_FILE_FORBIDDEN_BASENAMES.has(base)) return `forbidden file: ${file}`
  if (/^tsconfig.*\.json$/.test(base)) return `forbidden file: ${file}`
  if (/\.config\./.test(base)) return `forbidden file: ${file}`
  return null
}

/** Null when every entry is a safe worktree-relative path; otherwise the reason the first bad one was rejected. */
export function validateChangedFiles(files: string[]): string | null {
  for (const file of files) {
    const reason = invalidChangedFile(file)
    if (reason) return reason
  }
  return null
}

export const realShell: ShellRunner = (cmd, args, cwd, env) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: cwd ?? process.cwd(), env: env ? { ...process.env, ...env } : process.env })
    let stdout = '', stderr = ''
    p.stdout.on('data', d => { stdout += String(d) })
    p.stderr.on('data', d => { stderr += String(d) })
    p.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    p.on('error', err => resolve({ code: 1, stdout, stderr: String(err) }))
  })

// Cross-task: GitHub identity is the bot account (standing ruling), never the
// ambient `gh` login. The same credential the github-dev collector reads.
export function pawdevGhEnv(): Record<string, string> {
  const token = getCredential('pawdev', 'github', 'token')
  return token ? { GH_TOKEN: token } : {}
}

async function defaultBuilderAgent(prompt: string, workRoot: string): Promise<string> {
  const { runAgent } = await import('../../agent.js')
  const { getSoul, buildAgentPrompt } = await import('../../souls.js')
  const soul = getSoul('pawdev--builder', 'pawdev')
  const full = soul ? `${buildAgentPrompt(soul, 'pawdev')}\n\n---\n\n${prompt}` : prompt
  const res = await runAgent(full, undefined, undefined, undefined, undefined,
    { projectId: 'pawdev', source: 'builder' }, { projectId: 'pawdev', agentId: 'builder', workRoot })
  return res.text ?? ''
}

function block(card: BuilderCard, reason: string): void {
  transitionActionItem(card.id, 'blocked', 'builder')
  updateActionItemFields(card.id, { last_run_at: Date.now(), last_run_result: reason.slice(0, 4000) })
}

// The default send goes through the same PawSender the routine's own cycle
// approval uses, registered once from index.ts (Task 9 fix round 1, item 1).
// A dynamic import keeps this file from statically depending on
// pawdev/actions.ts, which already imports pawdevGhEnv from here.
const defaultSend: PawSender = async (chatId, text, keyboard, projectId) => {
  const { getPawdevCardSender } = await import('../pawdev/actions.js')
  const sender = getPawdevCardSender()
  if (!sender) {
    logger.warn('[pawdev] no card sender registered, merge approval card not sent')
    return
  }
  await sender(chatId, text, keyboard, projectId)
}

// REPORT for this cycle. Deterministic and cheap: the collector payload, the
// cards and repo_events already say what happened, so no model call is
// needed. The HISTORY.md export is best effort; a failure there must not
// cost the cycle its report text (Task 10).
function finish(cycleId: string): string {
  const raw = observeRawForCycle(cycleId)
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000
  const events = listRepoEvents({ sinceMs: since, limit: 1000 })
  const cards = listActionItems({ projectId: 'pawdev' }) as unknown as Array<{ status: string; source: string }>
  const text = raw ? renderReport(repoLines(raw, cards, events)) : 'No collector payload this cycle.'
  try {
    writeHistoryFile(renderHistoryMarkdown(events, repoEventStats(since), Date.now()), PROJECT_ROOT)
  } catch (err) {
    logger.warn({ err }, '[pawdev] HISTORY.md export failed, the table is still correct')
  }
  return text
}

export function createPawdevBuilder(deps: {
  sh: ShellRunner
  runBuilderAgent: (prompt: string, workRoot: string) => Promise<string>
  send?: PawSender
}): PostActHandler {
  const { sh, runBuilderAgent, send = defaultSend } = deps

  return async (cycleId, pawId, projectId): Promise<string> => {
    const queued = (listActionItems({ projectId: 'pawdev', status: 'approved' }) as unknown as BuilderCard[])
    const card = pickBuildableCard(queued)
    if (!card) {
      logger.info({ cycleId, queued: queued.length }, '[pawdev] no trivial or small card queued, builder idle')
      return finish(cycleId)
    }

    // 0. Refuse outright on a dirty live checkout. The builder never commits there.
    const status = await sh('git', ['status', '--porcelain'], PROJECT_ROOT)
    if (status.stdout.trim() !== '') {
      block(card, 'worktree dirty')
      logger.warn({ cycleId, card: card.id }, '[pawdev] live checkout is dirty, card left on Needs you')
      return finish(cycleId)
    }

    const { repo, ref } = refFields(card)
    const branch = branchNameFor(card)
    const worktreeDir = worktreeDirFor(card)
    const ghEnv = pawdevGhEnv()
    if (!ghEnv.GH_TOKEN) {
      block(card, 'missing credential pawdev/github/token')
      logger.warn({ cycleId, card: card.id }, '[pawdev] no GitHub credential configured, card left on Needs you')
      return finish(cycleId)
    }

    transitionActionItem(card.id, 'in_progress', 'builder')

    // 1. Worktree on its own branch. Never a bare checkout in the live tree.
    // A retry of a card whose push landed but whose pull request failed finds
    // the branch already there; `-b` would fail on it and the error path would
    // then delete the branch holding the pushed commits (final review, Minor 19).
    const existing = await sh('git', ['branch', '--list', branch], PROJECT_ROOT)
    const reusingBranch = existing.stdout.trim() !== ''
    const addArgs = reusingBranch
      ? ['worktree', 'add', worktreeDir, branch]
      : ['worktree', 'add', worktreeDir, '-b', branch]
    const wt = await sh('git', addArgs, PROJECT_ROOT)
    if (wt.code !== 0) {
      block(card, `worktree failed: ${wt.stderr || wt.stdout}`)
      // git worktree add can create the branch before failing on the
      // directory itself; clean it up so a retry does not fail again on
      // "branch already exists". Only a branch this attempt made: on the reuse
      // path the branch holds commits that are already pushed
      // (re-review, New Breakage 2).
      if (!reusingBranch) await sh('git', ['branch', '-D', branch], PROJECT_ROOT)
      return finish(cycleId)
    }

    // `git worktree add` checks out tracked files only, and node_modules is
    // the first line of .gitignore, so tsc and vitest are not on the path in
    // there and every card would block at typecheck. A symlink to the repo's
    // own node_modules is enough for both.
    const link = await sh('ln', ['-s', join(PROJECT_ROOT, 'node_modules'), 'node_modules'], worktreeDir)
    if (link.code !== 0) {
      // Without the link typecheck fails with a message about tsc, which says
      // nothing about the real cause (re-review, Low 4).
      block(card, `node_modules link failed: ${(link.stderr || link.stdout).trim().slice(-500)}`)
      await sh('git', ['worktree', 'remove', worktreeDir, '--force'], PROJECT_ROOT)
      if (!reusingBranch) await sh('git', ['branch', '-D', branch], PROJECT_ROOT)
      return finish(cycleId)
    }

    let pushed = false
    try {
      // 2. The agent edits files, inside the worktree (runtimeContext.workRoot).
      // It runs nothing itself.
      const out = await runBuilderAgent(
        `Card ${card.id}\nRepo ${repo}\nIssue ${ref}\nBranch ${branch}\nWorktree ${worktreeDir}\n\n${card.title}\n\n${card.description ?? ''}`,
        worktreeDir,
      )
      let plan: { changed_files: string[]; summary: string; body: string }
      try {
        const cleaned = out.replace(/^[\s\S]*?(\{[\s\S]*\})\s*$/, '$1')
        plan = JSON.parse(cleaned) as typeof plan
      } catch {
        block(card, `builder returned no JSON plan: ${out.slice(0, 500)}`)
        return finish(cycleId)
      }
      if (!plan.changed_files || plan.changed_files.length === 0) {
        block(card, `builder refused: ${plan.body || plan.summary}`)
        return finish(cycleId)
      }
      const badFile = validateChangedFiles(plan.changed_files)
      if (badFile) { block(card, `builder named a path it should not touch: ${badFile}`); return finish(cycleId) }

      // 3. Typecheck, inside the worktree.
      const tc = await sh('npm', ['run', 'typecheck'], worktreeDir)
      if (tc.code !== 0) { block(card, `typecheck failed:\n${(tc.stdout + tc.stderr).slice(-2000)}`); return finish(cycleId) }

      // 4. Tests for the files that changed, not the whole suite. CI runs the
      // rest. No `--` here: vitest's cac parser reads everything after it as
      // options['--'], never as `related`'s own file-list positionals, so a
      // separator turns this into an empty, always-passing run
      // (fix round 2 HIGH). validateChangedFiles above already rejects a
      // leading `-`, which was the only thing `--` was defending against.
      const vt = await sh('npx', ['vitest', 'related', '--run', ...plan.changed_files], worktreeDir)
      if (vt.code !== 0) { block(card, `tests failed:\n${(vt.stdout + vt.stderr).slice(-2000)}`); return finish(cycleId) }

      // 5. Leak scan on the worktree, the same script the three sync scripts use.
      const leak = await sh(join(PROJECT_ROOT, 'scripts', 'lib', 'leak-scan.sh'), [worktreeDir], PROJECT_ROOT)
      if (leak.code !== 0) { block(card, `leak scan refused the worktree:\n${leak.stdout.slice(0, 2000)}`); return finish(cycleId) }

      // 6. Commit only the changed files, push and open the pull request
      // through the policy wrappers. The wrappers are invoked by absolute
      // path (Critical 2): they compute their own ROOT from $0's dirname, so
      // a relative `scripts/...` resolves against the worktree cwd and finds
      // no dist/ there. The worktree stays the cwd so `git push` inside the
      // wrapper acts on the right tree.
      // Drop the link before anything stages files. It is a symlink, so plain
      // rm removes the link only and never walks into the real tree.
      await sh('rm', ['node_modules'], worktreeDir)
      const add = await sh('git', ['add', '--', ...plan.changed_files], worktreeDir)
      if (add.code !== 0) { block(card, `git add failed:\n${(add.stdout + add.stderr).slice(-2000)}`); return finish(cycleId) }
      const commit = await sh('git', ['commit', '-m', `fix: ${plan.summary}\n\nCloses ${repo}${ref}`], worktreeDir)
      if (commit.code !== 0) { block(card, `git commit failed:\n${(commit.stdout + commit.stderr).slice(-2000)}`); return finish(cycleId) }

      const push = await sh(join(PROJECT_ROOT, 'scripts', 'git-push-wrapper.sh'), ['pawdev', '-u', 'origin', branch], worktreeDir, ghEnv)
      if (push.code !== 0) { block(card, `push blocked or failed (exit ${push.code}): ${push.stderr || push.stdout}`); return finish(cycleId) }
      pushed = true

      const pr = await sh(join(PROJECT_ROOT, 'scripts', 'gh-wrapper.sh'), [
        'pawdev', 'pr', 'create', '-R', repo, '--head', branch, '--base', 'main',
        '--title', plan.summary, '--body', `${plan.body}\n\nCloses ${ref}\n\nOpened by Paw Dev. Merge is a human decision.`,
      ], worktreeDir, ghEnv)
      if (pr.code !== 0) {
        // The commits are on the remote. Say so, so a retry is a retry of the
        // pull request and not of the whole card.
        block(card, `pushed branch ${branch}; PR failed: ${(pr.stderr || pr.stdout).trim().slice(-500)}`)
        return finish(cycleId)
      }

      const url = pr.stdout.trim().split('\n').filter(Boolean).pop() ?? ''
      writeRepoEvent({ repo, kind: 'pr_opened', ref: url || branch, actor: 'builder', item_id: card.id })
      updateActionItemFields(card.id, {
        external_ref: JSON.stringify({ issue: refFields(card).issue, branch, pr: url }),
        last_run_at: Date.now(),
        last_run_result: `pull request opened: ${url}`,
      })
      // Merge is always ask. The card waits on the owner from here. A send
      // failure logs and continues; it must not leave the card unreadable.
      try {
        const { pawdevApprovalRows } = await import('../pawdev/actions.js')
        const paw = getPaw(getDb(), pawId)
        if (paw) {
          await send(
            paw.config.chat_id,
            `Paw Dev opened ${url} for ${card.title}. Merge when ready.`,
            { inline_keyboard: pawdevApprovalRows([card.id]) },
            projectId,
          )
        }
      } catch (err) {
        logger.warn({ err, cycleId, card: card.id }, '[pawdev] merge approval card send failed, card is still open')
      }
      transitionActionItem(card.id, 'blocked', 'builder')
      logger.info({ cycleId, pawId, projectId, card: card.id, url }, '[pawdev] pull request opened, waiting on the owner to merge')
    } catch (err) {
      // A throw here (writeRepoEvent, updateActionItemFields, anything else)
      // must not strand the card on in_progress with nobody told (Important 2).
      block(card, `builder handler threw: ${String(err instanceof Error ? err.message : err).slice(0, 300)}`)
    } finally {
      // A worktree is a build artifact. Never leave it behind, win or lose.
      await sh('git', ['worktree', 'remove', worktreeDir, '--force'], PROJECT_ROOT)
      // A branch from a failed attempt blocks the next retry of the same card
      // with "branch already exists". Only the branch behind an open pull
      // request survives.
      if (!pushed) await sh('git', ['branch', '-D', branch], PROJECT_ROOT)
    }
    return finish(cycleId)
  }
}

export const pawdevBuilderHandler: PostActHandler = createPawdevBuilder({
  sh: realShell,
  runBuilderAgent: defaultBuilderAgent,
})
