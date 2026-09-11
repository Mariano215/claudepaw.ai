// src/remediations/cli-version-guard.ts
//
// Keeps the Claude Code CLI new enough for the models the agents ask for.
//
// This exists because of a real outage, not a hypothetical one. Between
// 2026-09-07 and 2026-09-08, 23 routine cycles failed across
// paw-trader-analyst, trader-pipeline-watchdog and fo-festival-tracker, every
// one of them with the same error:
//
//   ANALYZE phase failed: Claude Code returned an error result: API Error: 400
//   Claude Code 2.1.141 does not support this model; version 2.1.251 or newer
//   is required. Run 'claude update', ...
//
// Nothing in the codebase asserted a CLI version, so the fix was a human
// noticing and running `claude update`. Every routine on claude_desktop breaks
// the same way the next time the binary falls behind.
//
// Deliberately evidence-driven: the required version is read out of the error
// text the API actually returned, never guessed. With no such error in the
// window the rule is a no-op, so it can never fire spuriously or chase a
// version nothing has asked for.
//
// Safety rails:
//   - Never swaps the binary while a cycle is mid-flight. Replacing the CLI
//     under a running agent is how you turn one failure into several.
//   - One update attempt per 24h, so a broken update cannot loop.
//   - The update itself is behind the `self_heal_cli_update` knob. Off means
//     detect and report, with the exact command to run by hand.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getDb, getKnob } from '../db.js'
import { logger } from '../logger.js'
import { countRunsInWindow } from './db.js'
import type { RemediationDefinition, RemediationOutcome } from './types.js'

const execFileAsync = promisify(execFile)

const REMEDIATION_ID = 'cli-version-guard'
const EVIDENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const MAX_UPDATES_24H = 1
const EXEC_TIMEOUT_MS = 120_000

/**
 * The API's own wording. Both halves matter: the version it saw and the version
 * it wants. Only the required half is used as the floor, because the reported
 * current version is whatever binary answered that call, which may not be the
 * one on PATH now.
 */
const REQUIRED_VERSION_RE = /version\s+(\d+\.\d+\.\d+)\s+or\s+newer\s+is\s+required/i

type Semver = [number, number, number]

export function parseSemver(raw: string): Semver | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Negative when a is older than b, 0 when equal, positive when newer. */
export function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/**
 * Highest version any recent cycle error demanded.
 *
 * Takes the maximum rather than the latest, so a stale error naming an older
 * floor cannot walk the requirement backwards.
 */
export function highestRequiredVersion(errors: Array<string | null>): Semver | null {
  let best: Semver | null = null
  for (const err of errors) {
    if (!err) continue
    const m = REQUIRED_VERSION_RE.exec(err)
    if (!m) continue
    const v = parseSemver(m[1])
    if (!v) continue
    if (!best || compareSemver(v, best) > 0) best = v
  }
  return best
}

/**
 * Where the CLI lives.
 *
 * Resolved rather than assumed: the bot runs under launchd, whose PATH is not
 * the shell's, so `claude` alone often is not found.
 */
async function resolveCliPath(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', ['claude'], { timeout: 10_000 })
    const p = stdout.trim()
    if (p && existsSync(p)) return p
  } catch { /* not on this PATH, try the usual places */ }

  for (const candidate of [
    join(homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function readCliVersion(cliPath: string): Promise<{ version: Semver | null; raw: string }> {
  const { stdout } = await execFileAsync(cliPath, ['--version'], { timeout: 30_000 })
  const raw = stdout.trim()
  return { version: parseSemver(raw), raw }
}

/** True when any cycle is still running, so the binary must not be replaced. */
function cyclesInFlight(db: ReturnType<typeof getDb>): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM paw_cycles
     WHERE phase NOT IN ('completed', 'failed')
       AND completed_at IS NULL
  `).get() as { n: number }
  return row.n ?? 0
}

export const cliVersionGuardRemediation: RemediationDefinition = {
  id: REMEDIATION_ID,
  name: 'Claude CLI version guard',
  tier: 'auto-safe',
  description:
    'Reads the required CLI version out of recent cycle errors and updates the binary when it is behind. Evidence-driven, so it is a no-op until a run has actually been refused.',

  async run(ctx): Promise<RemediationOutcome> {
    const db = getDb()
    const errors: string[] = []

    const rows = db.prepare(`
      SELECT error FROM paw_cycles
       WHERE error IS NOT NULL
         AND started_at >= ?
       ORDER BY started_at DESC
       LIMIT 200
    `).all(ctx.now - EVIDENCE_WINDOW_MS) as Array<{ error: string | null }>

    const required = highestRequiredVersion(rows.map((r) => r.error))
    if (!required) {
      return { acted: false, summary: 'No cycle error has named a required CLI version.' }
    }
    const requiredStr = required.join('.')

    const cliPath = await resolveCliPath()
    if (!cliPath) {
      return {
        acted: false,
        summary: `A cycle needed CLI ${requiredStr} but the claude binary could not be found.`,
        detail: { required: requiredStr },
        errors: ['claude binary not found on PATH or in the usual install locations'],
      }
    }

    let current: Semver | null
    let currentRaw: string
    try {
      const read = await readCliVersion(cliPath)
      current = read.version
      currentRaw = read.raw
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        acted: false,
        summary: `Could not read the CLI version at ${cliPath}.`,
        detail: { required: requiredStr, cliPath },
        errors: [msg],
      }
    }

    if (!current) {
      return {
        acted: false,
        summary: `Could not parse a version from "${currentRaw}".`,
        detail: { required: requiredStr, cliPath, currentRaw },
        errors: [`unparsable --version output: ${currentRaw}`],
      }
    }

    if (compareSemver(current, required) >= 0) {
      return {
        acted: false,
        summary: `CLI ${current.join('.')} meets the required ${requiredStr}.`,
        detail: { current: current.join('.'), required: requiredStr, cliPath },
      }
    }

    // Behind. Everything below decides whether to act, and refuses loudly
    // rather than acting at a bad moment.
    const base = {
      current: current.join('.'),
      required: requiredStr,
      cliPath,
      fix: `${cliPath} update`,
    }

    if (!getKnob('default', 'self_heal_cli_update', true)) {
      return {
        acted: false,
        summary: `CLI ${base.current} is behind the required ${requiredStr}. Auto-update is off, run: ${base.fix}`,
        detail: base,
      }
    }

    const inFlight = cyclesInFlight(db)
    if (inFlight > 0) {
      return {
        acted: false,
        summary: `CLI ${base.current} is behind ${requiredStr}, holding: ${inFlight} cycle(s) still running.`,
        detail: { ...base, cyclesInFlight: inFlight },
      }
    }

    const attempts = countRunsInWindow(REMEDIATION_ID, 24 * 60 * 60 * 1000, (logRow) => {
      if (!logRow.detail) return false
      try {
        return Boolean((JSON.parse(logRow.detail) as { updateAttempted?: boolean }).updateAttempted)
      } catch {
        return false
      }
    })
    if (attempts >= MAX_UPDATES_24H) {
      return {
        acted: false,
        summary: `CLI ${base.current} is behind ${requiredStr} and an update already ran today. Needs a human: ${base.fix}`,
        detail: { ...base, updateAttemptsToday: attempts },
        errors: [`update attempted ${attempts}x in 24h without reaching ${requiredStr}`],
      }
    }

    if (ctx.dryRun) {
      return {
        acted: true,
        summary: `Would update the CLI from ${base.current} to at least ${requiredStr}.`,
        detail: { ...base, dryRun: true },
      }
    }

    logger.warn({ ...base }, '[remediations] CLI behind the version a model run required, updating')
    try {
      await execFileAsync(cliPath, ['update'], { timeout: EXEC_TIMEOUT_MS })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        acted: true,
        summary: `CLI update from ${base.current} failed. Run it by hand: ${base.fix}`,
        detail: { ...base, updateAttempted: true, updateSucceeded: false },
        errors: [msg],
      }
    }

    // Trust the binary, not the exit code.
    let after: Semver | null = null
    let afterRaw = ''
    try {
      const read = await readCliVersion(cliPath)
      after = read.version
      afterRaw = read.raw
    } catch { /* reported below as an unverified update */ }

    if (!after) {
      return {
        acted: true,
        summary: `CLI update ran but the new version could not be read. Check: ${cliPath} --version`,
        detail: { ...base, updateAttempted: true, afterRaw },
        errors: ['could not read the version after updating'],
      }
    }

    const reached = compareSemver(after, required) >= 0
    return {
      acted: true,
      summary: reached
        ? `Updated the CLI from ${base.current} to ${after.join('.')}, clearing the ${requiredStr} requirement.`
        : `CLI update left it at ${after.join('.')}, still short of ${requiredStr}. Needs a human.`,
      detail: { ...base, updateAttempted: true, updateSucceeded: true, after: after.join('.'), reached },
      errors: reached ? undefined : [`after updating, ${after.join('.')} is still below ${requiredStr}`],
    }
  },
}
