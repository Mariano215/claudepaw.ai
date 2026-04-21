#!/usr/bin/env node
// src/reports/daily-usage-report.ts
//
// Daily (or weekly) ClaudePaw usage + API report.
//
// What it does:
//   1. Reads telemetry.db (agent_events) + claudepaw.db (paws, scheduled_tasks,
//      project_settings) and the dashboard API (cost-gate, kill-switch).
//   2. Builds an inline-styled HTML email covering cost, paws health, task
//      failures, provider usage, top agents, and auto-detected anomalies.
//   3. Emails it via the existing Gmail OAuth pipeline (src/google/gmail.ts).
//   4. Always writes the HTML to /tmp/claudepaw-daily-report.html for offline
//      review.
//
// Usage:
//   node dist/reports/daily-usage-report.js             # gather + send
//   node dist/reports/daily-usage-report.js --preview   # render only, no email
//
// Env (read from .env):
//   DAILY_REPORT_ENABLED        default "true"
//   DAILY_REPORT_TO             default ""
//   DAILY_REPORT_PERIOD_HOURS   default 24 (flip to 168 for weekly)
//   DASHBOARD_URL, DASHBOARD_API_TOKEN (reused from existing config)
//
// No LLM, no agents, deterministic. Safe to run on a cron without gating.

import Database from 'better-sqlite3'
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { PROJECT_ROOT, readEnvFile } from '../env.js'
import { sendEmail } from '../google/gmail.js'
import { renderDailyHtml } from './daily-html.js'
import type {
  ReportData,
  ProjectCost,
  PawFailure,
  TaskFailure,
  TopAgent,
  ProviderStat,
  Anomaly,
  KillSwitchState,
  RemediationRow,
} from './types.js'

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const env = readEnvFile()
const RECIPIENT = env.DAILY_REPORT_TO || ''
const ENABLED = (env.DAILY_REPORT_ENABLED ?? 'true').toLowerCase() !== 'false'
const PERIOD_HOURS = Math.max(1, Number(env.DAILY_REPORT_PERIOD_HOURS ?? '24') || 24)
const DASHBOARD_URL = env.DASHBOARD_URL || 'http://127.0.0.1:3000'
const DASHBOARD_API_TOKEN = env.DASHBOARD_API_TOKEN || ''
const PREVIEW_PATH = '/tmp/claudepaw-daily-report.html'

const STORE_DIR = path.join(PROJECT_ROOT, 'store')
const TELEMETRY_DB = path.join(STORE_DIR, 'telemetry.db')
const CORE_DB = path.join(STORE_DIR, 'claudepaw.db')

// -----------------------------------------------------------------------------
// Data gathering
// -----------------------------------------------------------------------------

function monthStartMs(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

function startOfTodayMs(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function startOfYesterdayMs(): number {
  return startOfTodayMs() - 24 * 60 * 60 * 1000
}

function periodLabel(hours: number): string {
  if (hours === 24) return 'Last 24 hours'
  if (hours === 168) return 'Last 7 days'
  if (hours === 1) return 'Last hour'
  if (hours % 24 === 0) return `Last ${hours / 24} days`
  return `Last ${hours} hours`
}

async function fetchKillSwitch(): Promise<KillSwitchState> {
  if (!DASHBOARD_URL || !DASHBOARD_API_TOKEN) {
    return { active: false }
  }
  try {
    const res = await fetch(
      `${DASHBOARD_URL}/api/v1/system-state/kill-switch`,
      {
        headers: { 'x-dashboard-token': DASHBOARD_API_TOKEN },
        signal: AbortSignal.timeout(5000),
      },
    )
    if (!res.ok) return { active: false }
    const data = (await res.json()) as any
    // Shape: { kill_switch_at, kill_switch_reason, set_by } or similar
    const atMs = Number(data?.kill_switch_at ?? data?.active_at ?? 0) || 0
    if (!atMs) return { active: false }
    return {
      active: true,
      reason: data?.kill_switch_reason ?? data?.reason ?? '',
      set_at: atMs,
      set_by: data?.set_by ?? '',
    }
  } catch {
    return { active: false }
  }
}

interface CostGateResponse {
  action: 'allow' | 'warn' | 'ollama' | 'blocked'
  percent_of_cap: number
  mtd_usd: number
  today_usd: number
  monthly_cap_usd: number | null
  daily_cap_usd: number | null
  triggering_cap: string | null
}

async function fetchCostGate(projectId: string): Promise<CostGateResponse | null> {
  if (!DASHBOARD_URL || !DASHBOARD_API_TOKEN) return null
  try {
    const res = await fetch(
      `${DASHBOARD_URL}/api/v1/cost-gate/${encodeURIComponent(projectId)}`,
      {
        headers: { 'x-dashboard-token': DASHBOARD_API_TOKEN },
        signal: AbortSignal.timeout(5000),
      },
    )
    if (!res.ok) return null
    return (await res.json()) as CostGateResponse
  } catch {
    return null
  }
}

function gatherCost(telemetry: InstanceType<typeof Database>): {
  today_usd: number
  yesterday_usd: number
  mtd_usd: number
  project_ids: string[]
} {
  const today = startOfTodayMs()
  const yesterday = startOfYesterdayMs()
  const monthStart = monthStartMs()

  const todaySum = (telemetry.prepare(
    `SELECT COALESCE(SUM(total_cost_usd), 0) AS t FROM agent_events WHERE received_at >= ?`,
  ).get(today) as { t: number }).t

  const yestSum = (telemetry.prepare(
    `SELECT COALESCE(SUM(total_cost_usd), 0) AS t FROM agent_events WHERE received_at >= ? AND received_at < ?`,
  ).get(yesterday, today) as { t: number }).t

  const mtdSum = (telemetry.prepare(
    `SELECT COALESCE(SUM(total_cost_usd), 0) AS t FROM agent_events WHERE received_at >= ?`,
  ).get(monthStart) as { t: number }).t

  const projectIds = (telemetry.prepare(
    `SELECT DISTINCT project_id FROM agent_events WHERE received_at >= ? ORDER BY project_id`,
  ).all(monthStart) as Array<{ project_id: string }>)
    .map(r => r.project_id)
    .filter(Boolean)

  return {
    today_usd: todaySum,
    yesterday_usd: yestSum,
    mtd_usd: mtdSum,
    project_ids: projectIds,
  }
}

async function gatherPerProjectCost(
  telemetry: InstanceType<typeof Database>,
  projectIds: string[],
): Promise<ProjectCost[]> {
  const today = startOfTodayMs()
  const monthStart = monthStartMs()
  const results: ProjectCost[] = []

  for (const pid of projectIds) {
    const todayRow = telemetry.prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) AS t FROM agent_events WHERE project_id = ? AND received_at >= ?`,
    ).get(pid, today) as { t: number }
    const mtdRow = telemetry.prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) AS t FROM agent_events WHERE project_id = ? AND received_at >= ?`,
    ).get(pid, monthStart) as { t: number }

    const gate = await fetchCostGate(pid)
    const cap = gate?.monthly_cap_usd ?? null
    const pct = cap !== null && cap > 0 ? (mtdRow.t / cap) * 100 : null

    results.push({
      project_id: pid,
      today: todayRow.t,
      mtd: mtdRow.t,
      cap_monthly: cap,
      pct_of_cap: pct,
      action: gate?.action ?? 'allow',
    })
  }

  results.sort((a, b) => b.mtd - a.mtd)
  return results
}

function gatherPaws(core: InstanceType<typeof Database>): ReportData['paws'] {
  const counts = core.prepare(
    `SELECT status, COUNT(*) AS c FROM paws GROUP BY status`,
  ).all() as Array<{ status: string; c: number }>

  const total = counts.reduce((s, r) => s + r.c, 0)
  const active = counts.find(r => r.status === 'active')?.c ?? 0
  const paused = counts.find(r => r.status === 'paused')?.c ?? 0
  const waiting = counts.find(r => r.status === 'waiting_approval')?.c ?? 0

  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const failed = (core.prepare(
    `SELECT paw_id, id AS cycle_id, error, COALESCE(completed_at, started_at) AS failed_at
       FROM paw_cycles
      WHERE phase = 'failed' AND COALESCE(completed_at, started_at) >= ?
      ORDER BY failed_at DESC LIMIT 20`,
  ).all(cutoff) as Array<PawFailure>).map(r => ({
    paw_id: r.paw_id,
    cycle_id: r.cycle_id,
    error: r.error || '(no error message)',
    failed_at: r.failed_at,
  }))

  return { total, active, paused, waiting_approval: waiting, failed_cycles_24h: failed }
}

function gatherScheduledTasks(core: InstanceType<typeof Database>): ReportData['scheduled_tasks'] {
  const totalActive = (core.prepare(
    `SELECT COUNT(*) AS c FROM scheduled_tasks WHERE status = 'active'`,
  ).get() as { c: number }).c

  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  // Heuristic: last_run in last 24h AND last_result contains an error marker.
  // The empty-text failures changed the shape to descriptive strings -- we flag
  // any result starting with the common error markers.
  const rows = core.prepare(
    `SELECT id, project_id, last_run, last_result
       FROM scheduled_tasks
      WHERE last_run IS NOT NULL
        AND last_run >= ?
        AND last_result IS NOT NULL
        AND (
          last_result LIKE '%[No response from agent]%'
          OR last_result LIKE '%Agent error%'
          OR last_result LIKE '%agent returned%'
          OR last_result LIKE '%TIMEOUT%'
          OR last_result LIKE '%timed out%'
          OR last_result LIKE '%error_during_execution%'
          OR last_result LIKE '%rate_limit%'
          OR last_result LIKE '%exceeded%cap%'
        )
      ORDER BY last_run DESC LIMIT 20`,
  ).all(cutoff) as Array<{ id: string; project_id: string; last_run: number; last_result: string }>

  return {
    total_active: totalActive,
    failures_24h: rows.map(r => ({
      id: r.id,
      project_id: r.project_id ?? 'default',
      last_run: r.last_run,
      error: r.last_result,
    })),
  }
}

function gatherRemediations(core: InstanceType<typeof Database>): RemediationRow[] {
  try {
    const exists = core.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='remediations'`,
    ).get()
    if (!exists) return []
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return core.prepare(
      `SELECT id, remediation_id, started_at, completed_at, acted, summary
         FROM remediations
        WHERE started_at >= ? AND acted = 1
        ORDER BY started_at DESC LIMIT 50`,
    ).all(cutoff) as RemediationRow[]
  } catch {
    return []
  }
}

function gatherAgentEvents(telemetry: InstanceType<typeof Database>, hoursBack: number): ReportData['agent_events'] {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000

  const totalRow = telemetry.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END), 0) AS errors,
            COALESCE(AVG(duration_ms), 0) AS avg_dur
       FROM agent_events WHERE received_at >= ?`,
  ).get(cutoff) as { total: number; errors: number; avg_dur: number }

  const byProvider = telemetry.prepare(
    `SELECT COALESCE(executed_provider, requested_provider, 'unknown') AS provider,
            COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END), 0) AS errors
       FROM agent_events
      WHERE received_at >= ?
      GROUP BY provider
      ORDER BY count DESC`,
  ).all(cutoff) as ProviderStat[]

  const topAgents = telemetry.prepare(
    `SELECT COALESCE(agent_id, 'unknown') AS agent_id,
            COUNT(*) AS calls,
            COALESCE(SUM(total_cost_usd), 0) AS cost_usd,
            COALESCE(SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END), 0) AS errors
       FROM agent_events
      WHERE received_at >= ?
      GROUP BY agent_id
      ORDER BY cost_usd DESC LIMIT 5`,
  ).all(cutoff) as TopAgent[]

  // Top tools by call count in the window. Only rows from events inside the
  // same window (guards against stale joined rows). Pure SQL, no LLM involved.
  let topTools: Array<{ tool_name: string; calls: number; failures: number }> = []
  try {
    topTools = telemetry.prepare(
      `SELECT tc.tool_name AS tool_name,
              COUNT(*) AS calls,
              SUM(CASE WHEN tc.success = 0 THEN 1 ELSE 0 END) AS failures
         FROM tool_calls tc
         JOIN agent_events e ON e.event_id = tc.event_id
        WHERE e.received_at >= ?
          AND tc.tool_name IS NOT NULL
        GROUP BY tc.tool_name
        ORDER BY calls DESC LIMIT 5`,
    ).all(cutoff) as Array<{ tool_name: string; calls: number; failures: number }>
  } catch {
    // tool_calls table missing or columns not migrated -- degrade to empty
    topTools = []
  }

  return {
    total_24h: totalRow.total,
    errors_24h: totalRow.errors,
    avg_duration_ms: totalRow.avg_dur,
    by_provider: byProvider,
    top_agents: topAgents,
    top_tools: topTools,
  }
}

type ReportCore = Omit<ReportData, 'anomalies' | 'overall_status' | 'overall_issues' | 'dashboard_url'>

function detectAnomalies(data: ReportCore): Anomaly[] {
  const out: Anomaly[] = []

  // Cost spike: today > 3x yesterday AND today > $5
  if (data.cost.today_usd > 5 && data.cost.yesterday_usd > 0 && data.cost.today_usd > data.cost.yesterday_usd * 3) {
    out.push({
      level: 'warn',
      message: `Cost spike: today $${data.cost.today_usd.toFixed(2)} is ${(data.cost.today_usd / data.cost.yesterday_usd).toFixed(1)}x yesterday ($${data.cost.yesterday_usd.toFixed(2)})`,
    })
  }

  // High error rate on any provider (>10% error rate with at least 10 calls)
  for (const p of data.agent_events.by_provider) {
    if (p.count >= 10 && p.errors / p.count > 0.1) {
      out.push({
        level: 'warn',
        message: `${p.provider} error rate is ${((p.errors / p.count) * 100).toFixed(1)}% over ${p.count} calls`,
      })
    }
  }

  // MTD approaching cap (>=80%)
  for (const p of data.cost.per_project) {
    if (p.pct_of_cap !== null && p.pct_of_cap >= 80 && p.pct_of_cap < 100) {
      out.push({
        level: 'warn',
        message: `${p.project_id} is at ${p.pct_of_cap.toFixed(0)}% of monthly cap ($${p.mtd.toFixed(2)} of $${p.cap_monthly?.toFixed(2)})`,
      })
    }
    if (p.pct_of_cap !== null && p.pct_of_cap >= 100) {
      out.push({
        level: 'crit',
        message: `${p.project_id} has exceeded monthly cap (${p.pct_of_cap.toFixed(0)}%, running on ${p.action})`,
      })
    }
  }

  // Paw failures concentrated on one paw (>=3 in 24h)
  const failuresByPaw = new Map<string, number>()
  for (const f of data.paws.failed_cycles_24h) {
    failuresByPaw.set(f.paw_id, (failuresByPaw.get(f.paw_id) ?? 0) + 1)
  }
  for (const [pawId, count] of failuresByPaw.entries()) {
    if (count >= 3) {
      out.push({
        level: 'warn',
        message: `Paw "${pawId}" failed ${count}x in the last 24h`,
      })
    }
  }

  // Many paws stuck waiting_approval
  if (data.paws.waiting_approval >= 3) {
    out.push({
      level: 'info',
      message: `${data.paws.waiting_approval} paws waiting for approval`,
    })
  }

  return out
}

function computeOverallStatus(data: ReportCore): { status: 'green' | 'yellow' | 'red'; issues: string[] } {
  const issues: string[] = []
  let status: 'green' | 'yellow' | 'red' = 'green'

  if (data.kill_switch.active) {
    status = 'red'
    issues.push('Kill switch is active')
  }
  if (data.paws.failed_cycles_24h.length > 0) {
    status = status === 'red' ? 'red' : 'yellow'
    issues.push(`${data.paws.failed_cycles_24h.length} paw cycle failures`)
  }
  if (data.scheduled_tasks.failures_24h.length > 0) {
    status = status === 'red' ? 'red' : 'yellow'
    issues.push(`${data.scheduled_tasks.failures_24h.length} scheduled task failures`)
  }
  if (data.agent_events.errors_24h > 0) {
    status = status === 'red' ? 'red' : 'yellow'
    issues.push(`${data.agent_events.errors_24h} agent errors`)
  }
  for (const p of data.cost.per_project) {
    if (p.pct_of_cap !== null && p.pct_of_cap >= 100) {
      status = 'red'
      issues.push(`${p.project_id} over monthly cap`)
    } else if (p.pct_of_cap !== null && p.pct_of_cap >= 80) {
      status = status === 'red' ? 'red' : 'yellow'
      issues.push(`${p.project_id} approaching cap`)
    }
  }

  return { status, issues }
}

async function gatherReportData(): Promise<ReportData> {
  const telemetry = new Database(TELEMETRY_DB, { readonly: true })
  const core = new Database(CORE_DB, { readonly: true })

  try {
    const killSwitch = await fetchKillSwitch()
    const costRoll = gatherCost(telemetry)
    const perProject = await gatherPerProjectCost(telemetry, costRoll.project_ids)
    const paws = gatherPaws(core)
    const tasks = gatherScheduledTasks(core)
    const events = gatherAgentEvents(telemetry, PERIOD_HOURS)
    const remediations = gatherRemediations(core)

    // Pick the largest monthly cap across projects as the headline MTD cap.
    const headlineCap = perProject.reduce<number | null>((max, p) => {
      if (p.cap_monthly == null) return max
      return max === null ? p.cap_monthly : Math.max(max, p.cap_monthly)
    }, null)

    const base = {
      generated_at: Date.now(),
      period: {
        hours: PERIOD_HOURS,
        from: Date.now() - PERIOD_HOURS * 60 * 60 * 1000,
        to: Date.now(),
        label: periodLabel(PERIOD_HOURS),
      },
      cost: {
        today_usd: costRoll.today_usd,
        yesterday_usd: costRoll.yesterday_usd,
        mtd_usd: costRoll.mtd_usd,
        mtd_cap: headlineCap,
        per_project: perProject,
      },
      kill_switch: killSwitch,
      paws,
      scheduled_tasks: tasks,
      agent_events: events,
      remediations_24h: remediations,
    }

    const anomalies = detectAnomalies(base)
    const { status, issues } = computeOverallStatus(base)

    return {
      ...base,
      anomalies,
      overall_status: status,
      overall_issues: issues,
      dashboard_url: DASHBOARD_URL ? `${DASHBOARD_URL}/#dashboard` : undefined,
    }
  } finally {
    telemetry.close()
    core.close()
  }
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function subjectFor(data: ReportData): string {
  const emoji =
    data.overall_status === 'green' ? '✅' :
    data.overall_status === 'yellow' ? '⚠️' : '🚨'
  const periodTag = PERIOD_HOURS === 24 ? 'Daily' : PERIOD_HOURS === 168 ? 'Weekly' : `${PERIOD_HOURS}h`
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${emoji} ClaudePaw ${periodTag} Report — ${date}`
}

async function main() {
  const args = process.argv.slice(2)
  const preview = args.includes('--preview') || args.includes('-p')
  const force = args.includes('--force') || args.includes('-f')

  if (!ENABLED && !force && !preview) {
    console.log('DAILY_REPORT_ENABLED=false -- exiting without sending. Use --force to override.')
    process.exit(0)
  }

  const data = await gatherReportData()
  const html = renderDailyHtml(data)
  const subject = subjectFor(data)

  // Always write the preview file so the report exists even if email fails
  writeFileSync(PREVIEW_PATH, html, 'utf-8')
  console.log(`Preview written: ${PREVIEW_PATH}`)

  if (preview) {
    console.log(`Status: ${data.overall_status}`)
    console.log(`Subject: ${subject}`)
    console.log(`Anomalies: ${data.anomalies.length}`)
    console.log(`Size: ${(html.length / 1024).toFixed(1)} KB`)
    return
  }

  const res = await sendEmail({ to: RECIPIENT, subject, htmlBody: html })
  if (!res.success) {
    console.error(`Email send failed: ${res.error}`)
    process.exit(1)
  }
  console.log(`Sent to ${RECIPIENT} (message id ${res.messageId})`)
}

main().catch((err) => {
  console.error('Report generation failed:', err)
  process.exit(1)
})
