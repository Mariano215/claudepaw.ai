// Deterministic pre-fetch for the Metric Healer task.
//
// The healer used to GET /metric-health/degraded itself. That cost tool
// round-trips: on 2026-08-18 the run spent the whole 600s claude_desktop
// budget and timed out, then fell through to a provider with no tool access
// which reported "All integrations healthy" while 8 rows were failing.
//
// Fetching here instead means the agent is handed the data and only has to
// analyze it, which is the same split the Paws observe collectors use
// (src/paws/collectors/index.ts). It also works on every execution provider,
// not just claude_desktop with tool use.

import { BOT_API_TOKEN, DASHBOARD_URL } from './config.js'

export const METRIC_HEALER_TASK_ID = 'metric-healer'

interface MetricHealthRow {
  integration_id: number
  project_id: string
  platform: string
  metric_prefix: string | null
  status: string
  attempts: number
  last_success: number | null
  reason: string | null
  missing_keys: string | null
}

/** Attempts at or above this have outlived any transient explanation. */
const ESCALATE_AT = 5

function formatRow(row: MetricHealthRow): string {
  const parts = [
    `- ${row.platform} (${row.status}, attempts=${row.attempts}`,
    row.attempts >= ESCALATE_AT ? ', ESCALATED' : '',
    row.last_success ? `, last_success=${new Date(row.last_success).toISOString()}` : ', never succeeded',
    `): ${(row.reason || 'no reason recorded').replace(/\s+/g, ' ').trim()}`,
  ]
  let line = parts.join('')
  const missing = row.missing_keys ? String(row.missing_keys) : ''
  if (missing && missing !== '[]') line += `\n  missing keys: ${missing}`
  return line
}

/**
 * Fetch the degraded/failing rows and render them for the healer prompt.
 *
 * Returns null when there is nothing wrong, so the caller leaves the prompt
 * untouched. Throws on transport/auth failure -- augmentTaskPrompt catches it
 * and tells the agent the context is unavailable rather than killing the run.
 */
export async function buildMetricHealthContext(): Promise<string | null> {
  if (!DASHBOARD_URL) throw new Error('DASHBOARD_URL not set')
  if (!BOT_API_TOKEN) throw new Error('BOT_API_TOKEN not set')

  const res = await fetch(`${DASHBOARD_URL}/api/v1/metric-health/degraded`, {
    headers: { 'x-dashboard-token': BOT_API_TOKEN },
  })
  if (!res.ok) throw new Error(`metric-health/degraded returned ${res.status}`)

  const rows = (await res.json()) as MetricHealthRow[]
  if (!Array.isArray(rows) || rows.length === 0) {
    return 'PRE-FETCHED METRIC HEALTH: every integration is healthy. Report exactly: 🩺 All integrations healthy.'
  }

  const byProject = new Map<string, MetricHealthRow[]>()
  for (const row of rows) {
    const list = byProject.get(row.project_id) ?? []
    list.push(row)
    byProject.set(row.project_id, list)
  }

  const blocks: string[] = []
  for (const [projectId, projectRows] of byProject) {
    projectRows.sort((a, b) => b.attempts - a.attempts)
    blocks.push(`${projectId}\n${projectRows.map(formatRow).join('\n')}`)
  }

  return [
    `PRE-FETCHED METRIC HEALTH (${rows.length} non-healthy row(s), fetched ${new Date().toISOString()}):`,
    '',
    blocks.join('\n\n'),
    '',
    'This IS the current state. Do not re-fetch it, and do not report anything as',
    'healthy that is listed above. Paused integrations are already excluded.',
  ].join('\n')
}
