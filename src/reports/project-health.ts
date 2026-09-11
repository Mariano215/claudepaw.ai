// src/reports/project-health.ts
//
// Read-only per-project review. Answers "what is actually alive here" from data
// rather than from memory, so dormant projects can be retired and half-wired
// ones can be finished on evidence.
//
// Writes nothing. Run it with:
//   npx tsx src/reports/project-health.ts
//   npx tsx src/reports/project-health.ts --json
//
// Every problem it reports carries fix steps, because an issue without a fix is
// a chore for the operator rather than a task an agent can pick up.

import Database from 'better-sqlite3'
import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env.PROJECT_ROOT ?? '.'
const BOT_DB = join(ROOT, 'store', 'claudepaw.db')
const TEL_DB = join(ROOT, 'store', 'telemetry.db')
const WINDOW_DAYS = 30
const CUTOFF = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000

export type Verdict = 'ACTIVE' | 'PAUSED' | 'DORMANT' | 'DEAD'

export interface Issue {
  /** Short problem statement. */
  what: string
  /** Why it matters, in one line. */
  why: string
  /** Ordered, literal steps. Written so an agent can run them unchanged. */
  fix: string[]
  /** How to confirm the fix worked. */
  verify: string
  /** True when an agent could do this end to end with no human decision. */
  agentExecutable: boolean
}

export interface ProjectHealth {
  id: string
  displayName: string
  status: string
  verdict: Verdict
  lastActivityAt: number | null
  /** Cost-bearing model calls only. Blind to routines before 2026-09-10. */
  lastAgentRunAt: number | null
  costUsd30d: number
  monthlyCapUsd: number | null
  routines: { seeded: number; active: number; definedNotSeeded: string[]; cycles30d: number; failed30d: number }
  tasks: { total: number; active: number; firing30d: number; failing: number }
  actionItems: Record<string, number>
  agentsNeverRun: string[]
  deadIntegrations: Array<{ id: string; status: string; error: string | null }>
  contextFileBytes: number | null
  issues: Issue[]
}

function openRead(path: string): Database.Database | null {
  try {
    return new Database(path, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
}

/**
 * Routines declared in code, keyed by project.
 *
 * brokerPaws is a real exported array. The claudepaw and default entries
 * live as literals inside scripts/paws-seed.ts, which is a script rather than a
 * module, so they are listed here by id. Keep this in step with that file; a
 * mismatch shows up as a false "defined but not seeded".
 */
export function definedRoutines(): Map<string, string[]> {
  const byProject = new Map<string, string[]>()
  const add = (project: string, id: string) => {
    const list = byProject.get(project) ?? []
    list.push(id)
    byProject.set(project, list)
  }
  add('broker', 'broker-deal-underwriter')
  add('pawdev', 'paw-dev-cycle')
  // From scripts/paws-seed.ts. Note these are declared under project_id
  // 'default' there, not 'claudepaw', which is itself worth a look.
  for (const id of ['sentinel-patrol']) {
    add('default', id)
  }
  for (const id of ['ms-trend-scanner', 'ms-channel-pulse', 'ms-social-cadence']) {
    add('default', id)
  }
  // Seeded by dedicated functions in src/paws/index.ts, called from src/index.ts.
  for (const id of ['paw-trader-analyst', 'paw-trader-coldstart', 'trader-pipeline-watchdog', 'trader-retrain-regime']) {
    add('trader', id)
  }
  add('default', 'claude-platform-tracker')
  add('example-company', 'fo-festival-tracker')
  return byProject
}

/**
 * Agent ids declared by files that actually load as agents.
 *
 * Files with no frontmatter are raw prompts read directly by their own code, not
 * agents. The seven projects/trader/agents/committee-*.md prompts are the case
 * that matters: src/trader/committee.ts reads them on every signal, so calling
 * them "never run" would be a confident wrong finding.
 */
function agentIdsOnDisk(slug: string): string[] {
  const dir = join(ROOT, 'projects', slug, 'agents')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => readFileSync(join(dir, f), 'utf8').startsWith('---'))
    .map((f) => f.replace(/\.md$/, ''))
}

function contextBytes(slug: string): number | null {
  const p = join(ROOT, 'projects', slug, 'context.md')
  if (!existsSync(p)) return null
  return statSync(p).size
}

function days(ms: number | null): string {
  if (ms === null) return 'never'
  const d = Math.floor((Date.now() - ms) / 86_400_000)
  return d === 0 ? 'today' : `${d}d ago`
}

export function gatherProjectHealth(): ProjectHealth[] {
  const bot = openRead(BOT_DB)
  if (!bot) throw new Error(`Cannot open ${BOT_DB}`)
  const tel = openRead(TEL_DB)

  const defined = definedRoutines()
  const projects = bot
    .prepare('SELECT id, slug, display_name, status FROM projects ORDER BY id')
    .all() as Array<{ id: string; slug: string; display_name: string; status: string }>

  const out: ProjectHealth[] = []

  for (const proj of projects) {
    const settings = bot
      .prepare('SELECT monthly_cost_cap_usd FROM project_settings WHERE project_id = ?')
      .get(proj.id) as { monthly_cost_cap_usd: number | null } | undefined

    // Cost and last run come from telemetry, which may be absent.
    let costUsd30d = 0
    let lastAgentRunAt: number | null = null
    let agentsRun = new Set<string>()
    if (tel) {
      const row = tel
        .prepare(`SELECT COALESCE(SUM(total_cost_usd), 0) AS cost, MAX(agent_ended_at) AS last
                    FROM agent_events WHERE project_id = ? AND agent_ended_at > ?`)
        .get(proj.id, CUTOFF) as { cost: number; last: number | null }
      costUsd30d = row.cost ?? 0
      lastAgentRunAt = row.last ?? null
      const ran = tel
        .prepare('SELECT DISTINCT agent_id FROM agent_events WHERE project_id = ? AND agent_id IS NOT NULL')
        .all(proj.id) as Array<{ agent_id: string }>
      agentsRun = new Set(ran.map((r) => r.agent_id))
    }

    const seededRoutines = bot
      .prepare('SELECT id, status FROM paws WHERE project_id = ?')
      .all(proj.id) as Array<{ id: string; status: string }>
    const seededIds = new Set(seededRoutines.map((r) => r.id))
    const definedNotSeeded = (defined.get(proj.id) ?? []).filter((id) => !seededIds.has(id))

    const cycles = bot
      .prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed
                  FROM paw_cycles WHERE started_at > ?
                   AND paw_id IN (SELECT id FROM paws WHERE project_id = ?)`)
      .get(CUTOFF, proj.id) as { n: number; failed: number | null }

    const tasks = bot
      .prepare(`SELECT COUNT(*) AS total,
                       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
                       SUM(CASE WHEN last_run > ? THEN 1 ELSE 0 END) AS firing,
                       SUM(CASE WHEN last_result LIKE '%rror%' OR last_result LIKE '%ailed%' THEN 1 ELSE 0 END) AS failing
                  FROM scheduled_tasks WHERE project_id = ?`)
      .get(CUTOFF, proj.id) as { total: number; active: number | null; firing: number | null; failing: number | null }

    const itemRows = bot
      .prepare('SELECT status, COUNT(*) AS n FROM action_items WHERE project_id = ? GROUP BY status')
      .all(proj.id) as Array<{ status: string; n: number }>
    const actionItems: Record<string, number> = {}
    for (const r of itemRows) actionItems[r.status] = r.n

    const integrations = bot
      .prepare(`SELECT integration_id AS id, status, last_error FROM installed_integrations
                 WHERE project_id = ? AND (status != 'active' OR last_error IS NOT NULL)`)
      .all(proj.id) as Array<{ id: string; status: string; last_error: string | null }>

    const onDisk = agentIdsOnDisk(proj.slug)
    const agentsNeverRun = onDisk.filter(
      (a) => !agentsRun.has(a) && !agentsRun.has(`${proj.slug}--${a}`),
    )

    // agent_events recorded nothing for routine runs until 2026-09-10, so it
    // alone reports "never" for a project driven entirely by routines. Take the
    // latest of all three activity signals instead of implying silence.
    const otherActivity = bot
      .prepare(`SELECT MAX(x) AS last FROM (
                  SELECT MAX(started_at) AS x FROM paw_cycles
                   WHERE paw_id IN (SELECT id FROM paws WHERE project_id = ?)
                  UNION ALL
                  SELECT MAX(last_run) AS x FROM scheduled_tasks WHERE project_id = ?
                )`)
      .get(proj.id, proj.id) as { last: number | null }
    const lastActivityAt = Math.max(lastAgentRunAt ?? 0, otherActivity.last ?? 0) || null

    const ctx = contextBytes(proj.slug)

    const health: ProjectHealth = {
      id: proj.id,
      displayName: proj.display_name || proj.id,
      status: proj.status,
      verdict: 'ACTIVE',
      lastActivityAt,
      lastAgentRunAt,
      costUsd30d,
      monthlyCapUsd: settings?.monthly_cost_cap_usd ?? null,
      routines: {
        seeded: seededRoutines.length,
        active: seededRoutines.filter((r) => r.status === 'active').length,
        definedNotSeeded,
        cycles30d: cycles.n ?? 0,
        failed30d: cycles.failed ?? 0,
      },
      tasks: {
        total: tasks.total ?? 0,
        active: tasks.active ?? 0,
        firing30d: tasks.firing ?? 0,
        failing: tasks.failing ?? 0,
      },
      actionItems,
      agentsNeverRun,
      deadIntegrations: integrations.map((i) => ({ id: i.id, status: i.status, error: i.last_error })),
      contextFileBytes: ctx,
      issues: [],
    }

    health.verdict = verdictFor(health)
    health.issues = issuesFor(health, proj.slug)
    out.push(health)
  }

  bot.close()
  tel?.close()
  return out
}

export function verdictFor(h: ProjectHealth): Verdict {
  // Paused is an answer, not a symptom. The operator parked it on purpose, so
  // it must not keep showing up as a decision to make.
  if (h.status === 'paused') return 'PAUSED'
  const ranRecently = h.lastActivityAt !== null && h.lastActivityAt > CUTOFF
  const hasAutomation = h.routines.active > 0 || h.tasks.active > 0
  if (ranRecently && hasAutomation) return 'ACTIVE'
  if (hasAutomation || h.routines.seeded > 0 || h.tasks.total > 0) return 'DORMANT'
  return 'DEAD'
}

function issuesFor(h: ProjectHealth, slug: string): Issue[] {
  const issues: Issue[] = []

  // A paused project is parked deliberately. Reporting its empty context file
  // and idle agents every run is noise the operator has already answered. Only
  // a routine still firing would be worth saying, and that is checked below.
  if (h.status === 'paused') {
    if (h.routines.active > 0 || h.tasks.active > 0) {
      issues.push({
        what: `paused, but ${h.routines.active} routine(s) and ${h.tasks.active} task(s) are still active`,
        why: 'A paused project that still fires is spending money and sending messages the operator thinks are switched off.',
        fix: [
          `sqlite3 store/claudepaw.db "UPDATE paws SET status='paused' WHERE project_id = '${h.id}';"`,
          `sqlite3 store/claudepaw.db "UPDATE scheduled_tasks SET status='paused' WHERE project_id = '${h.id}';"`,
          'Project status is a label today: nothing in the bot stops a routine because its project is paused. Until that is enforced, pausing the rows is the only thing that actually stops work.',
        ],
        verify: `Both queries return zero rows with status 'active' for this project.`,
        agentExecutable: true,
      })
    }
    return issues
  }

  if (h.contextFileBytes === 0 || h.contextFileBytes === null) {
    issues.push({
      what: `projects/${slug}/context.md is ${h.contextFileBytes === null ? 'missing' : 'empty'}`,
      why: 'Every agent prompt for this project is built without project context, so agents work blind and invent details.',
      fix: [
        `Write projects/${slug}/context.md covering: what this project is, who it serves, the current goal, the named systems and accounts it touches, and anything an agent must never do.`,
        'Use projects/broker/context.md as the shape to follow; it is the most complete one in the repo.',
      ],
      verify: `wc -c projects/${slug}/context.md returns well over 0, then run one routine and confirm its report references project specifics.`,
      agentExecutable: false,
    })
  }

  if (h.routines.definedNotSeeded.length > 0) {
    issues.push({
      what: `${h.routines.definedNotSeeded.length} routine(s) defined in code but not in the database: ${h.routines.definedNotSeeded.join(', ')}`,
      why: 'The work was written and never switched on. It consumes no budget and produces nothing.',
      fix: [
        'npm run paws:seed',
        `sqlite3 store/claudepaw.db "SELECT id, status, cron FROM paws WHERE project_id = '${h.id}';"`,
        'If a routine should stay off, delete its definition rather than leaving it defined-but-absent, so this report stops flagging it.',
      ],
      verify: `The routine appears in paws with status 'active' and a next_run in the future.`,
      agentExecutable: true,
    })
  }

  if (h.routines.failed30d > 0) {
    issues.push({
      what: `${h.routines.failed30d} of ${h.routines.cycles30d} routine cycles failed in ${WINDOW_DAYS} days`,
      why: 'A failing routine reports nothing, so the project looks quiet when it is actually broken.',
      fix: [
        `sqlite3 store/claudepaw.db "SELECT paw_id, datetime(started_at/1000,'unixepoch','localtime'), substr(error,1,200) FROM paw_cycles WHERE error IS NOT NULL AND started_at > ${CUTOFF} AND paw_id IN (SELECT id FROM paws WHERE project_id = '${h.id}') ORDER BY started_at DESC;"`,
        'Read the error before changing anything. One real failure appears up to four times because the paw-retry remediation retries three times, so divide the raw count.',
        'If the error names a required Claude Code version, the fix is `claude update`, not code.',
      ],
      verify: 'The next cycle for that routine reaches phase completed with error NULL.',
      agentExecutable: false,
    })
  }

  if (h.tasks.failing > 0) {
    issues.push({
      what: `${h.tasks.failing} scheduled task(s) have a failing last_result`,
      why: 'A task that fails silently is worse than no task: the schedule implies coverage that does not exist.',
      fix: [
        `sqlite3 store/claudepaw.db "SELECT id, schedule, datetime(last_run/1000,'unixepoch','localtime'), substr(last_result,1,200) FROM scheduled_tasks WHERE project_id = '${h.id}' AND (last_result LIKE '%rror%' OR last_result LIKE '%ailed%');"`,
        'Fix or delete. A task kept in a failing state is a false sense of coverage.',
      ],
      verify: 'last_result no longer matches error or failed after the next run.',
      agentExecutable: false,
    })
  }

  const proposed = h.actionItems.proposed ?? 0
  if (proposed > 50) {
    issues.push({
      what: `${proposed} action items are still in 'proposed' and have never been reviewed`,
      why: 'Nothing can execute from proposed, so a large backlog means agent output is being generated and discarded.',
      fix: [
        `sqlite3 store/claudepaw.db "SELECT status, COUNT(*) FROM action_items WHERE project_id = '${h.id}' GROUP BY status;"`,
        `Triage in bulk: archive anything older than 30 days that nobody acted on, via POST /api/v1/action-items/:id/transition.`,
        'Then reduce the inflow or raise the bar in the proposing agent, otherwise the backlog returns.',
      ],
      verify: 'Proposed count drops and stays down for a week.',
      agentExecutable: false,
    })
  }

  if (h.agentsNeverRun.length > 0) {
    issues.push({
      what: `${h.agentsNeverRun.length} agent(s) have never run: ${h.agentsNeverRun.join(', ')}`,
      why: h.costUsd30d === 0
        ? 'No agent_events row names it. Because this project records no cost either, treat this as unproven rather than idle: confirm by hand before deleting anything.'
        : 'An agent with no routine, task or chat entry point is a prompt file nobody calls.',
      fix: [
        'Either give the agent a routine or scheduled task, or delete the file.',
        `Check nothing references it first: grep -rn "${h.agentsNeverRun[0]}" src/ scripts/ projects/`,
      ],
      verify: 'The agent appears in agent_events, or its file is gone.',
      agentExecutable: false,
    })
  }

  for (const i of h.deadIntegrations) {
    issues.push({
      what: `integration ${i.id} is ${i.status}${i.error ? ` with error: ${i.error.slice(0, 80)}` : ''}`,
      why: 'A broken integration makes dashboard cards render zeros, which reads as "nothing happened" rather than "not connected".',
      fix: [
        `Open the dashboard Integrations page for ${h.id} and reconnect ${i.id}.`,
        'If the service is no longer used, uninstall it so no card is rendered for it.',
      ],
      verify: 'status is active and last_error is NULL.',
      agentExecutable: false,
    })
  }

  // A project that is plainly active but reports no spend means the cost path
  // is not recording, not that the work was free. Saying $0.00 without comment
  // would be a confident wrong number.
  const activeRecently = h.lastActivityAt !== null && h.lastActivityAt > CUTOFF
  if (activeRecently && h.costUsd30d === 0) {
    issues.push({
      what: `active in the last ${WINDOW_DAYS} days but 30-day cost reads $0.00`,
      why: 'Model calls on this project are not landing in agent_events, so its spend is invisible to the dashboard, the daily report and per-project cost caps. The cap cannot enforce what it cannot see.',
      fix: [
        `sqlite3 store/telemetry.db "SELECT source, COUNT(*), datetime(MAX(agent_ended_at)/1000,'unixepoch','localtime') FROM agent_events WHERE project_id = '${h.id}' GROUP BY source;"`,
        'Find the code path that runs the model for this project and check it wraps the call in startRequest(...) then finalize() plus postEventToServer(), the way src/paws/agent-runner.ts and the scheduled-task path in src/scheduler.ts do.',
        'Known offender: callers of runAgentWithResolvedExecution in src/agent-runtime.ts bypass both the gate wiring and telemetry by design, so anything using it records nothing.',
      ],
      verify: `After the next run, the query above shows a row with a recent timestamp and this report shows a non-zero 30-day cost.`,
      agentExecutable: false,
    })
  }

  if (h.monthlyCapUsd === null) {
    issues.push({
      what: 'no monthly cost cap is set',
      why: 'The per-project cost gate has nothing to enforce, so this project can only be stopped by the account-wide pool gate.',
      fix: [
        `Set one on the dashboard, or: PUT /api/v1/cost-gate/${h.id}/caps with a monthly_cost_cap_usd.`,
        `30-day spend was $${h.costUsd30d.toFixed(2)}, so pick a cap above that with headroom.`,
      ],
      verify: `GET /api/v1/cost-gate/${h.id} returns a non-null monthly_cap_usd.`,
      agentExecutable: false,
    })
  }

  return issues
}

function render(all: ProjectHealth[]): string {
  const lines: string[] = []
  lines.push(`ClaudePaw project health -- ${new Date().toISOString().slice(0, 10)} (${WINDOW_DAYS}-day window)`)
  lines.push('')

  const width = 16
  lines.push(
    'PROJECT'.padEnd(width) + 'VERDICT'.padEnd(9) + 'ACTIVITY'.padEnd(10) +
    '30D COST'.padEnd(10) + 'ROUTINES'.padEnd(12) + 'TASKS'.padEnd(8) + 'ISSUES',
  )
  lines.push('-'.repeat(78))
  for (const h of all) {
    lines.push(
      h.id.slice(0, width - 1).padEnd(width) +
      h.verdict.padEnd(9) +
      days(h.lastActivityAt).padEnd(10) +
      `$${h.costUsd30d.toFixed(2)}`.padEnd(10) +
      `${h.routines.active}/${h.routines.seeded}`.padEnd(12) +
      `${h.tasks.active}/${h.tasks.total}`.padEnd(8) +
      String(h.issues.length),
    )
  }
  lines.push('')
  lines.push('ROUTINES is active/seeded. TASKS is active/total.')
  lines.push('')

  for (const h of all) {
    lines.push('='.repeat(78))
    lines.push(`${h.displayName}  (${h.id})   ${h.verdict}   status=${h.status}`)
    lines.push('')
    const items = Object.entries(h.actionItems).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'
    lines.push(`  last activity    ${days(h.lastActivityAt)}  (routine cycle, task run or agent call)`)
    lines.push(`  last costed run  ${days(h.lastAgentRunAt)}  (agent_events; blind to routines before 2026-09-10)`)
    lines.push(`  30-day cost      $${h.costUsd30d.toFixed(2)}${h.monthlyCapUsd === null ? '  (no cap set)' : ` of $${h.monthlyCapUsd} cap`}`)
    lines.push(`  routines         ${h.routines.active} active of ${h.routines.seeded} seeded, ${h.routines.cycles30d} cycles, ${h.routines.failed30d} failed`)
    if (h.routines.definedNotSeeded.length) {
      lines.push(`  not seeded       ${h.routines.definedNotSeeded.join(', ')}`)
    }
    lines.push(`  tasks            ${h.tasks.active} active of ${h.tasks.total}, ${h.tasks.firing30d} fired, ${h.tasks.failing} failing`)
    lines.push(`  action items     ${items}`)
    lines.push(`  context.md       ${h.contextFileBytes === null ? 'MISSING' : `${h.contextFileBytes} bytes`}`)
    if (h.agentsNeverRun.length) lines.push(`  never ran        ${h.agentsNeverRun.join(', ')}`)
    lines.push('')

    if (h.issues.length === 0) {
      lines.push('  No issues found.')
      lines.push('')
      continue
    }
    lines.push(`  ${h.issues.length} issue(s):`)
    h.issues.forEach((iss, n) => {
      lines.push('')
      lines.push(`  ${n + 1}. ${iss.what}`)
      lines.push(`     why:    ${iss.why}`)
      lines.push(`     fix:`)
      iss.fix.forEach((f) => lines.push(`       - ${f}`))
      lines.push(`     verify: ${iss.verify}`)
      lines.push(`     agent-executable: ${iss.agentExecutable ? 'yes' : 'no, needs a human decision'}`)
    })
    lines.push('')
  }
  return lines.join('\n')
}

const isMain = process.argv[1]?.endsWith('project-health.ts') || process.argv[1]?.endsWith('project-health.js')
if (isMain) {
  const all = gatherProjectHealth()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(all, null, 2))
  } else {
    console.log(render(all))
  }
}
