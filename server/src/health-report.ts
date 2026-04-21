// server/src/health-report.ts
//
// Server-side equivalent of src/reports/gather in the bot. Gathers the same
// ReportData shape (cost, paws, tasks, providers, top agents, remediations,
// anomalies) used by the daily email, but sourced from the server's DB
// connections so the dashboard can render a live page from a single endpoint.
//
// Pragmatic decision: the SQL is duplicated from the bot-side gather functions
// because the bot and server are separate TypeScript projects with separate
// tsconfig rootDirs. Both sides target the same ReportData contract, so
// visual parity holds across the email + dashboard.

import type Database from 'better-sqlite3'
import { getDb, getBotDb, getTelemetryDb } from './db.js'
import { getKillSwitch } from './system-state.js'

// -----------------------------------------------------------------------------
// Contract -- mirrors src/reports/types.ts on the bot side.
// -----------------------------------------------------------------------------

export interface ProjectCost {
  project_id: string
  today: number
  mtd: number
  cap_monthly: number | null
  pct_of_cap: number | null
  action: 'allow' | 'warn' | 'ollama' | 'blocked'
}

export interface PawFailure {
  paw_id: string
  cycle_id: string
  error: string
  failed_at: number
}

export interface TaskFailure {
  id: string
  project_id: string
  last_run: number
  error: string
}

export interface TopAgent {
  agent_id: string
  calls: number
  cost_usd: number
  errors: number
}

export interface ProviderStat {
  provider: string
  count: number
  errors: number
}

export interface Anomaly {
  level: 'info' | 'warn' | 'crit'
  message: string
}

export interface RemediationRow {
  id: number
  remediation_id: string
  started_at: number
  completed_at: number
  acted: 0 | 1
  summary: string
}

export interface KillSwitchState {
  active: boolean
  reason?: string
  set_at?: number
  set_by?: string
}

export interface ReportData {
  generated_at: number
  period: { hours: number; from: number; to: number; label: string }
  overall_status: 'green' | 'yellow' | 'red'
  overall_issues: string[]
  cost: {
    today_usd: number
    yesterday_usd: number
    mtd_usd: number
    mtd_cap: number | null
    per_project: ProjectCost[]
  }
  kill_switch: KillSwitchState
  paws: {
    total: number
    active: number
    paused: number
    waiting_approval: number
    failed_cycles_24h: PawFailure[]
  }
  scheduled_tasks: {
    total_active: number
    failures_24h: TaskFailure[]
  }
  agent_events: {
    total_24h: number
    errors_24h: number
    by_provider: ProviderStat[]
    top_agents: TopAgent[]
    avg_duration_ms: number
  }
  remediations_24h: RemediationRow[]
  anomalies: Anomaly[]
}

// -----------------------------------------------------------------------------
// Gather helpers
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

function gatherCost(telemetry: Database.Database): {
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

function perProjectCost(
  telemetry: Database.Database,
  bot: Database.Database,
  projectIds: string[],
): ProjectCost[] {
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

    let cap: number | null = null
    try {
      const capRow = bot.prepare(
        `SELECT monthly_cost_cap_usd FROM project_settings WHERE project_id = ?`,
      ).get(pid) as { monthly_cost_cap_usd: number | null } | undefined
      cap = capRow?.monthly_cost_cap_usd ?? null
    } catch {
      // project_settings table missing -- treat as no cap configured
    }
    const pct = cap !== null && cap > 0 ? (mtdRow.t / cap) * 100 : null

    let action: ProjectCost['action'] = 'allow'
    if (pct !== null) {
      if (pct >= 100) action = 'blocked'
      else if (pct >= 80) action = 'ollama'
      else if (pct >= 50) action = 'warn'
    }

    results.push({
      project_id: pid,
      today: todayRow.t,
      mtd: mtdRow.t,
      cap_monthly: cap,
      pct_of_cap: pct,
      action,
    })
  }

  results.sort((a, b) => b.mtd - a.mtd)
  return results
}

function gatherPaws(bot: Database.Database): ReportData['paws'] {
  try {
    const counts = bot.prepare(
      `SELECT status, COUNT(*) AS c FROM paws GROUP BY status`,
    ).all() as Array<{ status: string; c: number }>

    const total = counts.reduce((s, r) => s + r.c, 0)
    const active = counts.find(r => r.status === 'active')?.c ?? 0
    const paused = counts.find(r => r.status === 'paused')?.c ?? 0
    const waiting = counts.find(r => r.status === 'waiting_approval')?.c ?? 0

    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    let failed: PawFailure[] = []
    try {
      failed = bot.prepare(
        `SELECT paw_id, id AS cycle_id, error, COALESCE(completed_at, started_at) AS failed_at
           FROM paw_cycles
          WHERE phase = 'failed' AND COALESCE(completed_at, started_at) >= ?
          ORDER BY failed_at DESC LIMIT 20`,
      ).all(cutoff) as PawFailure[]
    } catch {
      // paw_cycles table missing -- not fatal, just report no failures
    }

    return {
      total,
      active,
      paused,
      waiting_approval: waiting,
      failed_cycles_24h: failed.map(r => ({
        paw_id: r.paw_id,
        cycle_id: r.cycle_id,
        error: r.error || '(no error message)',
        failed_at: r.failed_at,
      })),
    }
  } catch {
    return { total: 0, active: 0, paused: 0, waiting_approval: 0, failed_cycles_24h: [] }
  }
}

function gatherScheduledTasks(bot: Database.Database): ReportData['scheduled_tasks'] {
  try {
    const exists = bot.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'`,
    ).get()
    if (!exists) return { total_active: 0, failures_24h: [] }
  } catch {
    return { total_active: 0, failures_24h: [] }
  }

  const totalActive = (bot.prepare(
    `SELECT COUNT(*) AS c FROM scheduled_tasks WHERE status = 'active'`,
  ).get() as { c: number }).c

  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const rows = bot.prepare(
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

function gatherAgentEvents(telemetry: Database.Database, hoursBack: number): ReportData['agent_events'] {
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

  return {
    total_24h: totalRow.total,
    errors_24h: totalRow.errors,
    avg_duration_ms: totalRow.avg_dur,
    by_provider: byProvider,
    top_agents: topAgents,
  }
}

function gatherRemediations(bot: Database.Database): RemediationRow[] {
  // remediations table may not exist yet on an older deploy -- tolerate that.
  try {
    const exists = bot.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='remediations'`,
    ).get()
    if (!exists) return []
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    return bot.prepare(
      `SELECT id, remediation_id, started_at, completed_at, acted, summary
         FROM remediations
        WHERE started_at >= ? AND acted = 1
        ORDER BY started_at DESC LIMIT 50`,
    ).all(cutoff) as RemediationRow[]
  } catch {
    return []
  }
}

type ReportCore = Omit<ReportData, 'anomalies' | 'overall_status' | 'overall_issues'>

function detectAnomalies(d: ReportCore): Anomaly[] {
  const out: Anomaly[] = []

  if (d.cost.today_usd > 5 && d.cost.yesterday_usd > 0 && d.cost.today_usd > d.cost.yesterday_usd * 3) {
    out.push({
      level: 'warn',
      message: `Cost spike: today $${d.cost.today_usd.toFixed(2)} is ${(d.cost.today_usd / d.cost.yesterday_usd).toFixed(1)}x yesterday ($${d.cost.yesterday_usd.toFixed(2)})`,
    })
  }
  for (const p of d.agent_events.by_provider) {
    if (p.count >= 10 && p.errors / p.count > 0.1) {
      out.push({
        level: 'warn',
        message: `${p.provider} error rate is ${((p.errors / p.count) * 100).toFixed(1)}% over ${p.count} calls`,
      })
    }
  }
  for (const p of d.cost.per_project) {
    if (p.pct_of_cap !== null && p.pct_of_cap >= 80 && p.pct_of_cap < 100) {
      out.push({ level: 'warn', message: `${p.project_id} is at ${p.pct_of_cap.toFixed(0)}% of monthly cap` })
    }
    if (p.pct_of_cap !== null && p.pct_of_cap >= 100) {
      out.push({ level: 'crit', message: `${p.project_id} has exceeded monthly cap (${p.pct_of_cap.toFixed(0)}%)` })
    }
  }
  const failuresByPaw = new Map<string, number>()
  for (const f of d.paws.failed_cycles_24h) {
    failuresByPaw.set(f.paw_id, (failuresByPaw.get(f.paw_id) ?? 0) + 1)
  }
  for (const [pawId, count] of failuresByPaw.entries()) {
    if (count >= 3) {
      out.push({ level: 'warn', message: `Paw "${pawId}" failed ${count}x in the last 24h` })
    }
  }
  if (d.paws.waiting_approval >= 3) {
    out.push({ level: 'info', message: `${d.paws.waiting_approval} paws waiting for approval` })
  }
  return out
}

function computeOverallStatus(d: ReportCore): { status: 'green' | 'yellow' | 'red'; issues: string[] } {
  const issues: string[] = []
  let status: 'green' | 'yellow' | 'red' = 'green'

  if (d.kill_switch.active) {
    status = 'red'
    issues.push('Kill switch is active')
  }
  if (d.paws.failed_cycles_24h.length > 0) {
    status = status === 'red' ? 'red' : 'yellow'
    issues.push(`${d.paws.failed_cycles_24h.length} paw cycle failures`)
  }
  if (d.scheduled_tasks.failures_24h.length > 0) {
    status = status === 'red' ? 'red' : 'yellow'
    issues.push(`${d.scheduled_tasks.failures_24h.length} scheduled task failures`)
  }
  if (d.agent_events.errors_24h > 0) {
    status = status === 'red' ? 'red' : 'yellow'
    issues.push(`${d.agent_events.errors_24h} agent errors`)
  }
  for (const p of d.cost.per_project) {
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

// -----------------------------------------------------------------------------
// Public
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Timeseries + event drill-in for the Usage page
// -----------------------------------------------------------------------------

export type TimeseriesBucket = 'hour' | 'day'

export interface TimeseriesPoint {
  ts: number           // ms epoch, start of bucket
  cost_usd: number
  calls: number
  errors: number
  by_provider: Record<string, number>  // provider -> cost_usd for stacking
}

export interface TimeseriesResult {
  from: number
  to: number
  bucket: TimeseriesBucket
  points: TimeseriesPoint[]
  filters_applied: {
    project_id: string | null
    provider: string | null
    agent_id: string | null
  }
}

export interface EventRow {
  event_id: string
  received_at: number
  project_id: string
  agent_id: string | null
  source: string | null
  model: string | null
  executed_provider: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  total_cost_usd: number | null
  duration_ms: number | null
  is_error: number
  prompt_summary: string | null
}

export interface EventsResult {
  from: number
  to: number
  total_count: number
  total_cost: number
  events: EventRow[]
  filters_applied: {
    project_id: string | null
    provider: string | null
    agent_id: string | null
  }
}

export interface TimeseriesQuery {
  hours: number
  bucket?: TimeseriesBucket
  project_id?: string | null
  provider?: string | null
  agent_id?: string | null
}

export interface EventsQuery {
  hours?: number
  from?: number
  to?: number
  project_id?: string | null
  provider?: string | null
  agent_id?: string | null
  /** Restrict events to those that invoked this tool at least once. */
  tool_name?: string | null
  limit?: number
}

function pickBucket(hours: number, explicit?: TimeseriesBucket): TimeseriesBucket {
  if (explicit === 'hour' || explicit === 'day') return explicit
  return hours <= 48 ? 'hour' : 'day'
}

function bucketExpr(bucket: TimeseriesBucket): string {
  // SQLite: bucket epoch-ms into hour or day boundaries.
  // hour: floor(ts / 3_600_000) * 3_600_000
  // day:  same with 86_400_000
  const width = bucket === 'hour' ? 3_600_000 : 86_400_000
  return `(CAST(received_at / ${width} AS INTEGER) * ${width})`
}

export function buildTimeseries(q: TimeseriesQuery): TimeseriesResult {
  const telemetry = getTelemetryDb()
  if (!telemetry) throw new Error('Telemetry DB not available')

  const hours = Math.max(1, Math.min(24 * 365, Math.round(q.hours)))
  const bucket = pickBucket(hours, q.bucket)
  const now = Date.now()
  const from = now - hours * 60 * 60 * 1000

  const where: string[] = ['received_at >= ?']
  const params: Array<string | number> = [from]
  if (q.project_id) { where.push('project_id = ?'); params.push(q.project_id) }
  if (q.provider) { where.push('COALESCE(executed_provider, requested_provider) = ?'); params.push(q.provider) }
  if (q.agent_id) { where.push('COALESCE(agent_id, \'unknown\') = ?'); params.push(q.agent_id) }
  const whereSql = where.join(' AND ')

  const buckExpr = bucketExpr(bucket)

  const rows = telemetry.prepare(`
    SELECT ${buckExpr} AS ts,
           COALESCE(executed_provider, requested_provider, 'unknown') AS provider,
           COALESCE(SUM(total_cost_usd), 0) AS cost_usd,
           COUNT(*) AS calls,
           SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS errors
      FROM agent_events
     WHERE ${whereSql}
     GROUP BY ts, provider
     ORDER BY ts ASC
  `).all(...params) as Array<{ ts: number; provider: string; cost_usd: number; calls: number; errors: number }>

  // Collapse (ts, provider) rows into per-bucket points.
  const byTs = new Map<number, TimeseriesPoint>()
  for (const r of rows) {
    const pt = byTs.get(r.ts) ?? { ts: r.ts, cost_usd: 0, calls: 0, errors: 0, by_provider: {} }
    pt.cost_usd += r.cost_usd
    pt.calls += r.calls
    pt.errors += r.errors
    pt.by_provider[r.provider] = (pt.by_provider[r.provider] ?? 0) + r.cost_usd
    byTs.set(r.ts, pt)
  }

  // Fill in zero-buckets so the chart has a continuous x-axis.
  const width = bucket === 'hour' ? 3_600_000 : 86_400_000
  const startBucket = Math.floor(from / width) * width
  const endBucket = Math.floor(now / width) * width
  const points: TimeseriesPoint[] = []
  for (let t = startBucket; t <= endBucket; t += width) {
    points.push(byTs.get(t) ?? { ts: t, cost_usd: 0, calls: 0, errors: 0, by_provider: {} })
  }

  return {
    from,
    to: now,
    bucket,
    points,
    filters_applied: {
      project_id: q.project_id ?? null,
      provider: q.provider ?? null,
      agent_id: q.agent_id ?? null,
    },
  }
}

export function listEvents(q: EventsQuery): EventsResult {
  const telemetry = getTelemetryDb()
  if (!telemetry) throw new Error('Telemetry DB not available')

  const now = Date.now()
  const hours = q.hours !== undefined ? Math.max(1, Math.min(24 * 365, Math.round(q.hours))) : 24
  const from = q.from ?? now - hours * 60 * 60 * 1000
  const to = q.to ?? now
  const limit = Math.max(1, Math.min(1000, q.limit ?? 200))

  const where: string[] = ['received_at >= ?', 'received_at <= ?']
  const params: Array<string | number> = [from, to]
  if (q.project_id) { where.push('project_id = ?'); params.push(q.project_id) }
  if (q.provider) { where.push('COALESCE(executed_provider, requested_provider) = ?'); params.push(q.provider) }
  if (q.agent_id) { where.push('COALESCE(agent_id, \'unknown\') = ?'); params.push(q.agent_id) }
  // tool_name: subquery matches events that invoked the named tool at least once
  if (q.tool_name) {
    where.push('event_id IN (SELECT DISTINCT event_id FROM tool_calls WHERE tool_name = ?)')
    params.push(q.tool_name)
  }
  const whereSql = where.join(' AND ')

  const totalRow = telemetry.prepare(
    `SELECT COUNT(*) AS total_count, COALESCE(SUM(total_cost_usd), 0) AS total_cost FROM agent_events WHERE ${whereSql}`,
  ).get(...params) as { total_count: number; total_cost: number }

  const rows = telemetry.prepare(`
    SELECT event_id, received_at, project_id, agent_id, source, model, executed_provider,
           input_tokens, output_tokens, cache_read_tokens, total_cost_usd, duration_ms, is_error,
           prompt_summary
      FROM agent_events
     WHERE ${whereSql}
     ORDER BY received_at DESC
     LIMIT ?
  `).all(...params, limit) as EventRow[]

  return {
    from,
    to,
    total_count: totalRow.total_count,
    total_cost: totalRow.total_cost,
    events: rows,
    filters_applied: {
      project_id: q.project_id ?? null,
      provider: q.provider ?? null,
      agent_id: q.agent_id ?? null,
    },
  }
}

// -----------------------------------------------------------------------------
// Main report
// -----------------------------------------------------------------------------

export function buildHealthReport(periodHours: number = 24): ReportData {
  // Source of truth for paws / scheduled_tasks / project_settings is the
  // SERVER DB (matches what the Paws page + Project Settings show). The bot
  // DB is the source of truth for the remediations log (bot-only feature).
  const server = getDb()
  const bot = getBotDb()
  const telemetry = getTelemetryDb()
  if (!server) throw new Error('Server DB not available')
  if (!telemetry) throw new Error('Telemetry DB not available')

  const ks = getKillSwitch()
  const killSwitch: KillSwitchState = ks
    ? { active: true, reason: ks.reason, set_at: ks.set_at, set_by: ks.set_by ?? undefined }
    : { active: false }

  const costRoll = gatherCost(telemetry)
  const perProject = perProjectCost(telemetry, server, costRoll.project_ids)
  const paws = gatherPaws(server)
  const tasks = gatherScheduledTasks(server)
  const events = gatherAgentEvents(telemetry, periodHours)
  // Remediations are mirrored from the bot to the server DB via
  // POST /api/v1/internal/remediations. Read from server DB so this works on
  // deploys where the bot DB is remote. Fall back to bot DB if the server
  // hasn't been migrated yet (backward compat).
  let remediations = gatherRemediations(server)
  if (remediations.length === 0 && bot) {
    remediations = gatherRemediations(bot)
  }

  const headlineCap = perProject.reduce<number | null>((max, p) => {
    if (p.cap_monthly == null) return max
    return max === null ? p.cap_monthly : Math.max(max, p.cap_monthly)
  }, null)

  const base = {
    generated_at: Date.now(),
    period: {
      hours: periodHours,
      from: Date.now() - periodHours * 60 * 60 * 1000,
      to: Date.now(),
      label: periodLabel(periodHours),
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

  return { ...base, anomalies, overall_status: status, overall_issues: issues }
}

// -----------------------------------------------------------------------------
// Tool-invocation usage (feature #17)
// -----------------------------------------------------------------------------

export interface ToolUsageRow {
  tool_name: string
  calls: number
  failures: number
  avg_duration_ms: number | null
}

export interface ToolMatrixRow {
  tool_name: string
  cells: Record<string, number>
  total: number
}

export interface ToolUsageReport {
  period: { hours: number; from: number; to: number; label: string }
  total_calls: number
  total_failures: number
  unique_tools: number
  tools: ToolUsageRow[]
  matrix: {
    agents: string[]
    rows: ToolMatrixRow[]
  }
  top_5_tools: Array<{ tool_name: string; calls: number }>
}

const UNATTRIBUTED_AGENT = '(unattributed)'

/**
 * Aggregate tool_calls within a rolling window. Joined to agent_events for
 * project + agent attribution + window filtering. Pure SQL -- no LLM calls
 * in this code path, matching the core ClaudePaw design principle.
 *
 * Three-state scope on allowedProjectIds:
 *   undefined / null  -> admin, no project filter
 *   []                -> caller has no project access, return empty
 *   ['proj-a', ...]   -> WHERE project_id IN (...)
 *
 * When project_id is also supplied, it must be a member of allowedProjectIds
 * or the report returns empty (prevents cross-project read leaks).
 */
export function buildToolUsage(params: {
  hours: number
  project_id?: string | null
  agent_id?: string | null
  allowedProjectIds?: string[] | null
}): ToolUsageReport {
  const hours = Math.max(1, Math.round(params.hours))
  const to = Date.now()
  const from = to - hours * 60 * 60 * 1000
  const period = { hours, from, to, label: periodLabel(hours) }

  const emptyReport: ToolUsageReport = {
    period,
    total_calls: 0,
    total_failures: 0,
    unique_tools: 0,
    tools: [],
    matrix: { agents: [], rows: [] },
    top_5_tools: [],
  }

  // No-access short-circuit.
  if (Array.isArray(params.allowedProjectIds) && params.allowedProjectIds.length === 0) {
    return emptyReport
  }
  // Cross-project read attempt -- return empty rather than leak a foreign project.
  if (
    params.project_id &&
    Array.isArray(params.allowedProjectIds) &&
    !params.allowedProjectIds.includes(params.project_id)
  ) {
    return emptyReport
  }

  const telemetry = getTelemetryDb()
  if (!telemetry) return emptyReport

  // Build the WHERE clause safely. Every user-derived value goes through
  // positional parameters; no string interpolation.
  const where: string[] = ['e.received_at >= ?', 'e.received_at <= ?']
  const args: Array<number | string> = [from, to]

  if (params.project_id) {
    where.push('e.project_id = ?')
    args.push(params.project_id)
  } else if (Array.isArray(params.allowedProjectIds)) {
    const placeholders = params.allowedProjectIds.map(() => '?').join(', ')
    where.push(`e.project_id IN (${placeholders})`)
    args.push(...params.allowedProjectIds)
  }

  if (params.agent_id) {
    where.push('e.agent_id = ?')
    args.push(params.agent_id)
  }

  const whereClause = where.join(' AND ')

  // Per-tool aggregates
  const toolRows = telemetry.prepare(`
    SELECT
      tc.tool_name                                AS tool_name,
      COUNT(*)                                    AS calls,
      SUM(CASE WHEN tc.success = 0 THEN 1 ELSE 0 END) AS failures,
      AVG(tc.duration_ms)                         AS avg_duration_ms
    FROM tool_calls tc
    JOIN agent_events e ON e.event_id = tc.event_id
    WHERE ${whereClause}
      AND tc.tool_name IS NOT NULL
    GROUP BY tc.tool_name
    ORDER BY calls DESC
  `).all(...args) as Array<{
    tool_name: string
    calls: number
    failures: number | null
    avg_duration_ms: number | null
  }>

  const tools: ToolUsageRow[] = toolRows.map(r => ({
    tool_name: r.tool_name,
    calls: r.calls,
    failures: r.failures ?? 0,
    avg_duration_ms: r.avg_duration_ms == null ? null : Math.round(r.avg_duration_ms),
  }))

  // Agent × tool matrix
  // Agent × tool matrix. The sentinel label is passed as a positional arg
  // (once per COALESCE) rather than interpolated, matching the "no string
  // interpolation" rule in the JSDoc above.
  const matrixRows = telemetry.prepare(`
    SELECT
      tc.tool_name                             AS tool_name,
      COALESCE(e.agent_id, ?) AS agent_id,
      COUNT(*)                                 AS calls
    FROM tool_calls tc
    JOIN agent_events e ON e.event_id = tc.event_id
    WHERE ${whereClause}
      AND tc.tool_name IS NOT NULL
    GROUP BY tc.tool_name, COALESCE(e.agent_id, ?)
  `).all(UNATTRIBUTED_AGENT, ...args, UNATTRIBUTED_AGENT) as Array<{ tool_name: string; agent_id: string; calls: number }>

  // Collect distinct agent labels preserving most-used first
  const agentTotals: Record<string, number> = {}
  for (const r of matrixRows) {
    agentTotals[r.agent_id] = (agentTotals[r.agent_id] ?? 0) + r.calls
  }
  const agents = Object.keys(agentTotals).sort((a, b) => agentTotals[b]! - agentTotals[a]!)

  // Pivot to { tool_name: { agent: calls } }
  const toolPivot: Record<string, ToolMatrixRow> = {}
  for (const r of matrixRows) {
    const row = toolPivot[r.tool_name] ?? { tool_name: r.tool_name, cells: {}, total: 0 }
    row.cells[r.agent_id] = (row.cells[r.agent_id] ?? 0) + r.calls
    row.total += r.calls
    toolPivot[r.tool_name] = row
  }
  const matrixOrdered = Object.values(toolPivot).sort((a, b) => b.total - a.total)

  const total_calls = tools.reduce((sum, t) => sum + t.calls, 0)
  const total_failures = tools.reduce((sum, t) => sum + t.failures, 0)

  return {
    period,
    total_calls,
    total_failures,
    unique_tools: tools.length,
    tools,
    matrix: { agents, rows: matrixOrdered },
    top_5_tools: tools.slice(0, 5).map(t => ({ tool_name: t.tool_name, calls: t.calls })),
  }
}
