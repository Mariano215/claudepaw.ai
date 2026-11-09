import Database from 'better-sqlite3'
import { getTelemetryDb } from './db.js'

function requireTelemetryDb(): Database.Database {
  const db = getTelemetryDb()
  if (!db) throw new Error('Telemetry database not available')
  return db
}

// -- Types --

export interface DailyTotal {
  date: string
  cost: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface AgentBreakdown {
  cost: number
  sessions: number
  inputTokens: number
  outputTokens: number
}

export interface SessionRow {
  event_id: string
  received_at: number
  agent_id: string | null
  model: string | null
  requested_provider: string | null
  executed_provider: string | null
  provider_fallback_applied: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  total_cost_usd: number
  prompt_summary: string | null
  duration_ms: number | null
  source: string | null
}

export interface LineItem {
  id: string
  label: string
  amount_usd: number
  period: string
  active: number
  created_at: number
}

export interface ProratedLineItem {
  id: string
  label: string
  amount_usd: number
  period: string
  prorated_usd: number
}

export interface CostSummary {
  range: string
  since: number
  until: number
  totalApiCost: number
  todayCost: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  sessionCount: number
  dailyTotals: DailyTotal[]
  byAgent: Record<string, AgentBreakdown>
  byModel: Record<string, number>
  heatmap: number[][]
  sessions: SessionRow[]
  lineItems: ProratedLineItem[]
  monthlyFixed: number
  projectedMonthlyApi: number
  projectedMonthlyTotal: number
  totalCostWithFixed: number
}

// -- Helpers --

function rangeToSince(range: string): number {
  const now = Date.now()
  switch (range) {
    case '7d': return now - 7 * 86_400_000
    case '30d': return now - 30 * 86_400_000
    case '90d': return now - 90 * 86_400_000
    case 'ytd': {
      const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime()
      return jan1
    }
    default: return now - 30 * 86_400_000
  }
}

function rangeDays(since: number, until: number): number {
  return Math.max(1, Math.round((until - since) / 86_400_000))
}

function todayStart(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// -- Main query --

export function getCostSummary(range: string, projectId?: string): CostSummary {
  const db = requireTelemetryDb()
  const until = Date.now()
  const since = rangeToSince(range)
  const days = rangeDays(since, until)

  const projectClause = projectId ? 'AND project_id = ?' : ''
  const projectParams = projectId ? [projectId] : []

  // KPI totals
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(total_cost_usd), 0) AS totalApiCost,
      COALESCE(SUM(input_tokens), 0) AS totalInputTokens,
      COALESCE(SUM(output_tokens), 0) AS totalOutputTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS totalCacheReadTokens,
      COALESCE(SUM(cache_creation_tokens), 0) AS totalCacheCreationTokens,
      COUNT(*) AS sessionCount
    FROM agent_events
    WHERE received_at >= ? AND received_at <= ? ${projectClause}
  `).get(since, until, ...projectParams) as Record<string, number>

  // Today's cost
  const todayRow = db.prepare(`
    SELECT COALESCE(SUM(total_cost_usd), 0) AS todayCost
    FROM agent_events
    WHERE received_at >= ? ${projectClause}
  `).get(todayStart(), ...projectParams) as { todayCost: number }

  // Daily totals
  const dailyRows = db.prepare(`
    SELECT
      DATE(received_at / 1000, 'unixepoch', 'localtime') AS date,
      COALESCE(SUM(total_cost_usd), 0) AS cost,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
      COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens
    FROM agent_events
    WHERE received_at >= ? AND received_at <= ? ${projectClause}
    GROUP BY date
    ORDER BY date
  `).all(since, until, ...projectParams) as DailyTotal[]

  // By agent
  const agentRows = db.prepare(`
    SELECT
      COALESCE(agent_id, 'direct') AS agent_id,
      COALESCE(SUM(total_cost_usd), 0) AS cost,
      COUNT(*) AS sessions,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens
    FROM agent_events
    WHERE received_at >= ? AND received_at <= ? ${projectClause}
    GROUP BY agent_id
    ORDER BY cost DESC
  `).all(since, until, ...projectParams) as Array<{ agent_id: string; cost: number; sessions: number; inputTokens: number; outputTokens: number }>

  const byAgent: Record<string, AgentBreakdown> = {}
  for (const r of agentRows) {
    byAgent[r.agent_id] = { cost: r.cost, sessions: r.sessions, inputTokens: r.inputTokens, outputTokens: r.outputTokens }
  }

  // By model
  const modelRows = db.prepare(`
    SELECT
      COALESCE(model, 'unknown') AS model,
      COALESCE(SUM(total_cost_usd), 0) AS cost
    FROM agent_events
    WHERE received_at >= ? AND received_at <= ? ${projectClause}
    GROUP BY model
    ORDER BY cost DESC
  `).all(since, until, ...projectParams) as Array<{ model: string; cost: number }>

  const byModel: Record<string, number> = {}
  for (const r of modelRows) {
    byModel[r.model] = r.cost
  }

  // Heatmap: 7 days (0=Mon..6=Sun) x 24 hours
  const heatmap: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0))
  const heatRows = db.prepare(`
    SELECT received_at, COALESCE(total_cost_usd, 0) AS cost
    FROM agent_events
    WHERE received_at >= ? AND received_at <= ? ${projectClause}
  `).all(since, until, ...projectParams) as Array<{ received_at: number; cost: number }>

  for (const r of heatRows) {
    const d = new Date(r.received_at)
    const dow = (d.getDay() + 6) % 7  // JS Sunday=0 -> Mon=0..Sun=6
    const hour = d.getHours()
    heatmap[dow][hour] += r.cost
  }

  // Session log (most recent 100)
  const sessions = db.prepare(`
    SELECT
      event_id, received_at, agent_id, model,
      requested_provider, executed_provider, provider_fallback_applied,
      COALESCE(input_tokens, 0) AS input_tokens,
      COALESCE(output_tokens, 0) AS output_tokens,
      COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
      COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
      COALESCE(total_cost_usd, 0) AS total_cost_usd,
      prompt_summary, duration_ms, source
    FROM agent_events
    WHERE received_at >= ? AND received_at <= ? ${projectClause}
    ORDER BY received_at DESC
    LIMIT 100
  `).all(since, until, ...projectParams) as SessionRow[]

  // Line items
  const rawItems = db.prepare(`
    SELECT id, label, amount_usd, period, active, created_at
    FROM cost_line_items
    WHERE active = 1
  `).all() as LineItem[]

  // Line items: show at face value (monthly = /mo, yearly = /yr), no proration
  const lineItems: ProratedLineItem[] = rawItems.map(item => ({
    id: item.id,
    label: item.label,
    amount_usd: item.amount_usd,
    period: item.period,
    prorated_usd: item.amount_usd, // face value, not prorated
  }))

  // Monthly fixed costs (sum of monthly items + yearly/12)
  const monthlyFixed = rawItems.reduce((sum, item) => {
    if (item.period === 'monthly') return sum + item.amount_usd
    if (item.period === 'yearly') return sum + item.amount_usd / 12
    return sum
  }, 0)

  // Projected monthly: extrapolate API daily rate + fixed monthly
  const apiDailyRate = days > 0 ? totals.totalApiCost / days : 0
  const projectedMonthlyApi = apiDailyRate * 30
  const projectedMonthlyTotal = Math.round((projectedMonthlyApi + monthlyFixed) * 100) / 100

  return {
    range,
    since,
    until,
    totalApiCost: totals.totalApiCost,
    todayCost: todayRow.todayCost,
    totalInputTokens: totals.totalInputTokens,
    totalOutputTokens: totals.totalOutputTokens,
    totalCacheReadTokens: totals.totalCacheReadTokens,
    totalCacheCreationTokens: totals.totalCacheCreationTokens,
    sessionCount: totals.sessionCount,
    dailyTotals: dailyRows,
    byAgent,
    byModel,
    heatmap,
    sessions,
    lineItems,
    monthlyFixed,
    projectedMonthlyApi,
    projectedMonthlyTotal,
    totalCostWithFixed: Math.round((totals.totalApiCost + monthlyFixed) * 100) / 100,
  }
}

// -- Line item CRUD --

export function getLineItems(): LineItem[] {
  return requireTelemetryDb()
    .prepare('SELECT id, label, amount_usd, period, active, created_at FROM cost_line_items ORDER BY created_at')
    .all() as LineItem[]
}

export function upsertLineItem(item: { id: string; label: string; amount_usd: number; period: string }): void {
  requireTelemetryDb()
    .prepare(`
      INSERT INTO cost_line_items (id, label, amount_usd, period, active, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, amount_usd = excluded.amount_usd, period = excluded.period
    `)
    .run(item.id, item.label, item.amount_usd, item.period, Date.now())
}

export function updateLineItem(id: string, updates: { amount_usd?: number; active?: number; label?: string }): boolean {
  const sets: string[] = []
  const vals: unknown[] = []
  if (updates.amount_usd !== undefined) { sets.push('amount_usd = ?'); vals.push(updates.amount_usd) }
  if (updates.active !== undefined) { sets.push('active = ?'); vals.push(updates.active) }
  if (updates.label !== undefined) { sets.push('label = ?'); vals.push(updates.label) }
  if (sets.length === 0) return false
  vals.push(id)
  const result = requireTelemetryDb()
    .prepare(`UPDATE cost_line_items SET ${sets.join(', ')} WHERE id = ?`)
    .run(...vals)
  return result.changes > 0
}

export function deleteLineItem(id: string): boolean {
  const result = requireTelemetryDb()
    .prepare('DELETE FROM cost_line_items WHERE id = ?')
    .run(id)
  return result.changes > 0
}
