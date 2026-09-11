#!/usr/bin/env tsx
// scripts/soak-report.ts
//
// Phase 4 done-when in one command: per project, how many routine cycles and
// cron tasks ran over the window, how many failed, how many error_log rows they
// wrote, and how many outbound messages they sent.
//
// Read-only. Opens both databases readonly so it is safe to run while the bot
// is up.
//
// Usage:
//   npx tsx scripts/soak-report.ts            # last 14 days
//   npx tsx scripts/soak-report.ts --days 7
//   npx tsx scripts/soak-report.ts --json
import path from 'node:path'
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { gatherCycleCounts, gatherCronRows } from '../src/reports/gather.js'
import { dateInTz } from '../src/reports/format.js'

const DAY_MS = 86_400_000

// The field is cron_tasks_ran, not cron_tasks_run: Phase 1's digest field
// (src/reports/gather.ts, ReportData.cron_tasks_run) counts tasks that ran in
// the window, and this field counts the same thing here. The different
// ending keeps the two distinguishable in a report that reads both.
export interface ProjectSoak {
  project_id: string
  cycles: number
  cycle_failures: number
  cron_tasks_ran: number
  cron_failures: number
  errors: number
  /** Outbound channel_log rows in the window: what the project actually sent. */
  messages: number
}

export interface SoakReport {
  days: number
  from_ms: number
  to_ms: number
  projects: ProjectSoak[]
  messages: number
}

/** A cron task records only its last result, so "failed" is a text test. These
 *  are the prefixes the scheduler and the agents actually write. */
const FAILURE_MARKERS = ['ERROR', 'BLOCKED', 'FAILED', 'Failed:', 'expired', 'unavailable', 'could not']

function looksFailed(result: string | null): boolean {
  if (!result) return false
  const head = result.slice(0, 300)
  return FAILURE_MARKERS.some(m => head.includes(m))
}

function safeAll<T>(db: InstanceType<typeof Database>, sql: string, ...params: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[]
  } catch {
    // A missing table means that half of the system has not been seeded here.
    return []
  }
}

export function buildSoakReport(
  core: InstanceType<typeof Database>,
  telemetry: InstanceType<typeof Database>,
  days: number,
  nowMs: number = Date.now(),
): SoakReport {
  const since = nowMs - days * DAY_MS
  const byProject = new Map<string, ProjectSoak>()
  const get = (id: string): ProjectSoak => {
    let row = byProject.get(id)
    if (!row) {
      row = { project_id: id, cycles: 0, cycle_failures: 0, cron_tasks_ran: 0, cron_failures: 0, errors: 0, messages: 0 }
      byProject.set(id, row)
    }
    return row
  }

  // Cycle and cron counts come from src/reports/gather.ts, the same queries the
  // daily digest runs, so this report and the digest never disagree on what
  // counts as a cycle or a cron task. Only the failure-marker text check on
  // last_result has no equivalent there.
  for (const c of gatherCycleCounts(core, since)) {
    const row = get(c.project_id)
    row.cycles += c.n
    row.cycle_failures += c.failed ?? 0
  }

  for (const t of gatherCronRows(core, since)) {
    const row = get(t.project_id)
    row.cron_tasks_ran++
    if (looksFailed(t.last_result)) row.cron_failures++
  }

  for (const e of safeAll<{ project_id: string; n: number }>(
    telemetry,
    `SELECT COALESCE(project_id,'default') AS project_id, COUNT(*) AS n
       FROM error_log WHERE recorded_at >= ? GROUP BY project_id`,
    since,
  )) {
    get(e.project_id).errors += e.n
  }

  for (const m of safeAll<{ project_id: string; n: number }>(
    core,
    `SELECT COALESCE(project_id,'default') AS project_id, COUNT(*) AS n
       FROM channel_log WHERE direction = 'out' AND created_at >= ? GROUP BY project_id`,
    since,
  )) {
    get(m.project_id).messages += m.n
  }

  const projects = [...byProject.values()].sort((a, b) => a.project_id.localeCompare(b.project_id))
  return {
    days,
    from_ms: since,
    to_ms: nowMs,
    projects,
    messages: projects.reduce((sum, p) => sum + p.messages, 0),
  }
}

function render(report: SoakReport): string {
  const head = `Soak report: last ${report.days} days (${dateInTz(report.from_ms)} to ${dateInTz(report.to_ms)})`
  const cols = ['project', 'cycles', 'cyc fail', 'cron ran', 'cron fail', 'errors', 'messages']
  const rows = report.projects.map(p => [
    p.project_id, String(p.cycles), String(p.cycle_failures),
    String(p.cron_tasks_ran), String(p.cron_failures), String(p.errors), String(p.messages),
  ])
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)))
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  const failing = report.projects.filter(p => p.cycle_failures > 0 || p.cron_failures > 0)
  const verdict = failing.length === 0
    ? 'PASS: no routine or cron failures in the window.'
    : `FAIL: ${failing.map(p => `${p.project_id} (${p.cycle_failures} cycle, ${p.cron_failures} cron)`).join(', ')}`
  return [head, '', line(cols), line(widths.map(w => '-'.repeat(w))), ...rows.map(line), '', verdict].join('\n')
}

/** better-sqlite3 throws a raw SqliteError on a missing readonly file. One
 *  line naming the path beats that stack trace for an owner running this from
 *  a checkout with no store/ yet. */
function openReadonlyOrExit(dbPath: string): InstanceType<typeof Database> {
  if (!existsSync(dbPath)) {
    console.error(`soak-report: missing store file: ${dbPath}`)
    process.exit(2)
  }
  return new Database(dbPath, { readonly: true })
}

function main(): void {
  const args = process.argv.slice(2)
  const daysArg = args.indexOf('--days')
  const days = daysArg >= 0 ? Math.max(1, Number(args[daysArg + 1]) || 14) : 14
  const storeDir = path.resolve(process.cwd(), 'store')
  const core = openReadonlyOrExit(path.join(storeDir, 'claudepaw.db'))
  const telemetry = openReadonlyOrExit(path.join(storeDir, 'telemetry.db'))
  try {
    const report = buildSoakReport(core, telemetry, days)
    process.stdout.write(args.includes('--json') ? JSON.stringify(report, null, 2) + '\n' : render(report) + '\n')
    if (report.projects.some(p => p.cycle_failures > 0 || p.cron_failures > 0)) process.exitCode = 1
  } finally {
    core.close()
    telemetry.close()
  }
}

if (process.argv[1] && process.argv[1].endsWith('soak-report.ts')) main()

// -----------------------------------------------------------------------------
// The other half of the Phase 4 done-when: "the digest reads as intended".
// That is a judgement, so it is a checklist the owner runs once on a real
// digest, not an assertion. All five must hold on the same message.
//
//  1. All five sections are present and in the spec 5.2 order: Needs you,
//     Handled without you, This week, Spend, Failures. A section with nothing
//     in it may be omitted, but the ones that appear stay in this order.
//  2. Every row links. In the email each row carries a dashboard href; in the
//     Telegram version each row names the page (Needs you, Work, Automations)
//     the owner opens to act on it.
//  3. No raw dumps. No stack trace, no JSON, no SQL, no agent transcript. A
//     failure is one line naming the routine, the project and the reason.
//  4. Every project with activity in the window has exactly one line under
//     "Handled without you", and no project appears twice.
//  5. Plain text on Telegram: no asterisks, no underscores, no backticks, no
//     angle brackets, no HTML entity codes.
//
// Check with: node dist/reports/daily-usage-report.js --preview
// then open /tmp/claudepaw-daily-report.html and read the Telegram text the
// same run writes to the log.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Trader historical statuses (final-review.md Minor 7). Removing 'rejected'
// from the trader terminal set is correct going forward, but a row written by
// an older build could still carry a status DECISION_STATUS no longer treats
// as terminal, and it would count as open forever. Run once before deploy:
//
//   sqlite3 store/claudepaw.db "select status, count(*) from trader_decisions
//     where status not in ('executed','closed','failed','committee_abstain')
//     group by status"
//
// Anything returned needs a decision on whether to backfill it to 'failed'.
// -----------------------------------------------------------------------------
