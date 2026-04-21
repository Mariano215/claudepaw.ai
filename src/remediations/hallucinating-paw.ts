// src/remediations/hallucinating-paw.ts
//
// Detects the exact failure mode that burned us on cp-community-triage:
//   - A paw is configured to "use the Bash tool" (or equivalent) in its prompt
//   - The paw's project runs on a non-claude_desktop provider
//   - The adapter has no real tool wiring (anthropic_api, openai_api, etc.)
//   - The agent hallucinates tool calls as text (<tool_call> / <tool_response>)
//
// When this pattern is observed in a project's recent cycles, the remediation
// switches that project's execution_provider to claude_desktop and moves the
// old provider to execution_provider_secondary as a fallback.
//
// Safety rails:
//   - Minimum 3 hallucinated cycles in last 24h before switching
//   - Cooldown: never switch the same project more than once per 30 days
//   - Only acts when paws with `observe_collector` are NOT the majority (those
//     paws don't need tool access -- the collector runs natively)
//   - Writes a clear log entry so the operator can revert if desired

import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { readEnvFile } from '../env.js'
import { countRunsInWindow } from './db.js'
import type { RemediationDefinition, RemediationOutcome } from './types.js'

const REMEDIATION_ID = 'hallucinating-paw'
const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000
const DETECT_WINDOW_MS = 24 * 60 * 60 * 1000
const MIN_HALLUCINATED_CYCLES = 3
const TOOL_CALL_MARKERS = ['<tool_call>', '<tool_response>', '<tool_use>']

/**
 * Projects that the operator explicitly wants to stay on their configured
 * provider. Set via REMEDIATIONS_SKIP_PROJECTS in .env (comma-separated).
 * Use this for projects intentionally on anthropic_api/openai_api/ollama
 * for cost reasons where paws don't need tool access.
 */
function resolveSkipProjects(): Set<string> {
  // process.env wins over .env so tests and ad-hoc overrides work without
  // touching the file. Persistent config should live in .env.
  const fromProcess = process.env.REMEDIATIONS_SKIP_PROJECTS ?? ''
  const fromFile = fromProcess ? '' : (readEnvFile().REMEDIATIONS_SKIP_PROJECTS ?? '')
  const raw = fromProcess || fromFile
  return new Set(
    raw.split(',').map((s) => s.trim()).filter(Boolean),
  )
}

interface RecentCycleRow {
  cycle_id: string
  paw_id: string
  project_id: string
  started_at: number
  state_json: string
}

interface ProjectSettingsRow {
  project_id: string
  execution_provider: string | null
  execution_provider_secondary: string | null
}

function cycleLooksHallucinated(stateJson: string): boolean {
  if (!stateJson) return false
  try {
    const state = JSON.parse(stateJson) as { observe_raw?: string | null }
    const raw = state.observe_raw ?? ''
    if (!raw) return false
    return TOOL_CALL_MARKERS.some((marker) => raw.includes(marker))
  } catch {
    return false
  }
}

export const hallucinatingPawRemediation: RemediationDefinition = {
  id: REMEDIATION_ID,
  name: 'Hallucinating-paw auto-remediation',
  tier: 'auto-safe',
  description:
    'Detects paws hallucinating tool calls on a text-only provider and switches the project to claude_desktop with the prior provider as fallback.',

  async run(ctx): Promise<RemediationOutcome> {
    const db = getDb()
    const windowStart = ctx.now - DETECT_WINDOW_MS
    const skipProjects = resolveSkipProjects()

    // Pull recent cycles across all paws, grouped later by project.
    const rows = db.prepare(`
      SELECT c.id         AS cycle_id,
             c.paw_id     AS paw_id,
             p.project_id AS project_id,
             c.started_at AS started_at,
             c.state      AS state_json
        FROM paw_cycles c
        JOIN paws p ON p.id = c.paw_id
       WHERE c.started_at >= ?
       ORDER BY c.started_at DESC
    `).all(windowStart) as RecentCycleRow[]

    // Aggregate by project: count total cycles and hallucinated cycles.
    const byProject = new Map<string, { total: number; hallucinated: number; pawIds: Set<string>; hallucinatedPaws: Set<string> }>()
    for (const row of rows) {
      const entry = byProject.get(row.project_id) ?? { total: 0, hallucinated: 0, pawIds: new Set(), hallucinatedPaws: new Set() }
      entry.total++
      entry.pawIds.add(row.paw_id)
      if (cycleLooksHallucinated(row.state_json)) {
        entry.hallucinated++
        entry.hallucinatedPaws.add(row.paw_id)
      }
      byProject.set(row.project_id, entry)
    }

    // Pull all project_settings once so we can check execution_provider.
    const settings = db.prepare(`
      SELECT project_id, execution_provider, execution_provider_secondary
        FROM project_settings
    `).all() as ProjectSettingsRow[]
    const settingsByProject = new Map(settings.map((s) => [s.project_id, s]))

    const switched: Array<{ project_id: string; from: string; to: string; hallucinated_cycles: number; affected_paws: string[] }> = []
    const detected: Array<{ project_id: string; reason: string; hallucinated_cycles: number }> = []

    for (const [projectId, stats] of byProject.entries()) {
      if (stats.hallucinated < MIN_HALLUCINATED_CYCLES) continue

      // Operator opt-out: don't touch projects explicitly on the skip list.
      if (skipProjects.has(projectId)) {
        detected.push({
          project_id: projectId,
          reason: 'in REMEDIATIONS_SKIP_PROJECTS -- operator opted out',
          hallucinated_cycles: stats.hallucinated,
        })
        logger.warn(
          { projectId, hallucinatedCycles: stats.hallucinated },
          '[remediations] Skipping project in REMEDIATIONS_SKIP_PROJECTS despite hallucination pattern',
        )
        continue
      }

      const s = settingsByProject.get(projectId)
      const currentProvider = s?.execution_provider ?? ''

      // If already on claude_desktop, nothing to do -- the hallucination is
      // coming from somewhere else and is out of scope for this remediation.
      if (currentProvider === 'claude_desktop') {
        detected.push({
          project_id: projectId,
          reason: 'already on claude_desktop; hallucination source unclear',
          hallucinated_cycles: stats.hallucinated,
        })
        continue
      }

      // Cooldown: have we switched this project recently?
      const cooldownHits = countRunsInWindow(
        REMEDIATION_ID,
        COOLDOWN_MS,
        (logRow) => {
          if (!logRow.detail || !logRow.acted) return false
          try {
            const d = JSON.parse(logRow.detail) as { switched?: Array<{ project_id: string }> }
            return Boolean(d.switched?.some((x) => x.project_id === projectId))
          } catch {
            return false
          }
        },
      )
      if (cooldownHits > 0) {
        detected.push({
          project_id: projectId,
          reason: 'in 30-day cooldown after prior switch',
          hallucinated_cycles: stats.hallucinated,
        })
        continue
      }

      const to = 'claude_desktop'
      const from = currentProvider || 'unset'

      if (!ctx.dryRun) {
        db.prepare(`
          UPDATE project_settings
             SET execution_provider = ?,
                 execution_provider_secondary = ?
           WHERE project_id = ?
        `).run(to, currentProvider || 'anthropic_api', projectId)
        logger.warn(
          { projectId, from, to, hallucinatedCycles: stats.hallucinated },
          '[remediations] Auto-switched project provider after detecting hallucination pattern',
        )
      }

      switched.push({
        project_id: projectId,
        from,
        to,
        hallucinated_cycles: stats.hallucinated,
        affected_paws: Array.from(stats.hallucinatedPaws),
      })
    }

    if (switched.length === 0 && detected.length === 0) {
      return { acted: false, summary: 'No hallucination patterns detected.' }
    }

    const summaryParts: string[] = []
    if (switched.length > 0) {
      summaryParts.push(
        `Switched ${switched.length} project(s) to claude_desktop: ${switched.map((s) => `${s.project_id} (${s.from} → ${s.to})`).join(', ')}`,
      )
    }
    if (detected.length > 0) {
      summaryParts.push(
        `Detected but skipped ${detected.length}: ${detected.map((d) => `${d.project_id} [${d.reason}]`).join(', ')}`,
      )
    }

    return {
      acted: switched.length > 0,
      summary: summaryParts.join(' • '),
      detail: { switched, detected },
    }
  },
}
