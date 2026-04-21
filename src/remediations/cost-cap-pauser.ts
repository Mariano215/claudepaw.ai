// src/remediations/cost-cap-pauser.ts
//
// Detects projects approaching or over their monthly cost cap and surfaces
// them in the daily report + dashboard. Does NOT mutate in v1 -- the existing
// cost-gate already handles the ollama fallback at 80% and the hard block at
// 100%. This remediation's job is to make those events visible in a human
// timeline instead of only in the cost_gate logs.
//
// Future: add per-paw `pauseable: true` config flag + auto-pause non-critical
// paws when a project is consistently at 100% of cap. Holding until the daily
// email shows whether it's needed.

import { getDb } from '../db.js'
import type { RemediationDefinition, RemediationOutcome } from './types.js'

const REMEDIATION_ID = 'cost-cap-pauser'
const WARN_THRESHOLD_PCT = 80
const BLOCK_THRESHOLD_PCT = 100

interface ProjectCapRow {
  project_id: string
  monthly_cost_cap_usd: number | null
}

interface MtdRow {
  project_id: string
  mtd: number
}

export const costCapPauserRemediation: RemediationDefinition = {
  id: REMEDIATION_ID,
  name: 'Cost cap watcher',
  tier: 'auto-safe',
  description:
    'Surfaces projects approaching or over their monthly cost cap. Existing cost-gate handles the provider switch; this records events for the daily report.',

  async run(): Promise<RemediationOutcome> {
    const db = getDb()

    // Pull each project's monthly cap and MTD spend.
    // Cost data lives in telemetry.db but we access it via the same DB file
    // connection -- the bot DB (store/claudepaw.db) also has project_settings
    // so that's the source of truth for caps.
    const capRows = db.prepare(`
      SELECT project_id, monthly_cost_cap_usd
        FROM project_settings
       WHERE monthly_cost_cap_usd IS NOT NULL
         AND monthly_cost_cap_usd > 0
    `).all() as ProjectCapRow[]

    if (capRows.length === 0) {
      return { acted: false, summary: 'No projects have monthly caps configured.' }
    }

    // MTD cost is in telemetry.db. Attach it via ATTACH DATABASE so we can
    // join across. better-sqlite3 supports this.
    const mtdRows: MtdRow[] = []
    try {
      db.exec(`ATTACH DATABASE '${db.name.replace(/'/g, "''").replace('claudepaw.db', 'telemetry.db')}' AS t`)
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
      const rows = db.prepare(`
        SELECT project_id, COALESCE(SUM(total_cost_usd), 0) AS mtd
          FROM t.agent_events
         WHERE received_at >= ?
         GROUP BY project_id
      `).all(monthStart) as MtdRow[]
      mtdRows.push(...rows)
    } catch {
      // Telemetry DB not attachable (maybe first boot). Skip silently.
    } finally {
      try { db.exec(`DETACH DATABASE t`) } catch { /* may not have been attached */ }
    }

    const mtdByProject = new Map(mtdRows.map((r) => [r.project_id, r.mtd]))

    const warnings: Array<{ project_id: string; mtd: number; cap: number; pct: number; level: 'warn' | 'block' }> = []

    for (const row of capRows) {
      const cap = row.monthly_cost_cap_usd ?? 0
      if (cap <= 0) continue
      const mtd = mtdByProject.get(row.project_id) ?? 0
      const pct = (mtd / cap) * 100
      if (pct >= BLOCK_THRESHOLD_PCT) {
        warnings.push({ project_id: row.project_id, mtd, cap, pct, level: 'block' })
      } else if (pct >= WARN_THRESHOLD_PCT) {
        warnings.push({ project_id: row.project_id, mtd, cap, pct, level: 'warn' })
      }
    }

    if (warnings.length === 0) {
      return { acted: false, summary: 'All projects below 80% of monthly cap.' }
    }

    const summaryParts = warnings.map(
      (w) => `${w.project_id} ${w.pct.toFixed(0)}% ($${w.mtd.toFixed(2)}/$${w.cap.toFixed(2)} ${w.level})`,
    )
    return {
      // acted=true because surfacing in the email IS the action for v1
      acted: true,
      summary: `Cost cap watch: ${summaryParts.join(', ')}`,
      detail: { warnings },
    }
  },
}
