// Digest data gathering. Kept out of daily-usage-report.ts because that file
// calls main() at import time, so a test importing it would send an email.
// Both functions take the DB handles so tests can pass an in-memory DB.
//
// Every timestamp read here is milliseconds (CLAUDE.md hard rule).
import type Database from 'better-sqlite3'
import type { NeedsYouItem, ProjectActivity } from './types.js'

type Db = InstanceType<typeof Database>

/** A missing table means the feature is not in use; the digest still renders. */
function safeAll<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[]
  } catch {
    return []
  }
}

/** Per-project routine cycle counts since `since`. Shared with scripts/soak-report.ts
 *  so the two never drift on what counts as a cycle or a failed one. */
export interface CycleCount { project_id: string; n: number; failed: number }
export function gatherCycleCounts(core: Db, since: number): CycleCount[] {
  return safeAll<CycleCount>(core, `
    SELECT p.project_id AS project_id, COUNT(*) AS n,
           SUM(CASE WHEN c.phase = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM paw_cycles c JOIN paws p ON p.id = c.paw_id
     WHERE c.started_at >= ? GROUP BY p.project_id
  `, since)
}

/** Cron task rows since `since`, one per task run. Raw rows (not a count) because
 *  scripts/soak-report.ts also needs `last_result` to tell a failed run from a
 *  clean one, which this table has no separate column for. */
export interface CronRow { project_id: string; last_result: string | null }
export function gatherCronRows(core: Db, since: number): CronRow[] {
  return safeAll<CronRow>(core, `
    SELECT project_id, last_result FROM scheduled_tasks WHERE last_run >= ?
  `, since)
}

/**
 * Everything across every project that is waiting on the owner (spec 5.2).
 * Routine cycles parked at DECIDE and proposed cards inside the window.
 * Open trader decisions are covered by Phase 2's Needs You count on the
 * dashboard side (trader_decisions has no pending status here).
 * Sorted oldest first, because the oldest is the one about to be auto-skipped.
 */
export function gatherNeedsYou(core: Db, windowMs: number, dashboardUrl: string): NeedsYouItem[] {
  const now = Date.now()
  const base = dashboardUrl.replace(/\/$/, '')
  const out: NeedsYouItem[] = []

  // Anchor the age on when the approval card was actually sent
  // (state.approval_requested_at, written by paws/engine.ts), the same field
  // src/paws/db.ts uses for the approval timeout. Fall back to cycle start
  // for cycles written before this field existed.
  const parked = safeAll<{ project_id: string; name: string; started_at: number; approval_requested_at: number | null }>(core, `
    SELECT p.project_id AS project_id, p.name AS name, c.started_at AS started_at,
           json_extract(c.state, '$.approval_requested_at') AS approval_requested_at
      FROM paws p
      JOIN (
        SELECT paw_id, started_at, state
          FROM paw_cycles
         WHERE (paw_id, started_at) IN (
           SELECT paw_id, MAX(started_at) FROM paw_cycles GROUP BY paw_id
         )
      ) c ON c.paw_id = p.id
     WHERE p.status = 'waiting_approval'
  `)
  for (const r of parked) {
    const anchor = typeof r.approval_requested_at === 'number' && r.approval_requested_at > 0
      ? r.approval_requested_at
      : r.started_at
    out.push({
      title: `Routine waiting on you: ${r.name}`,
      project_id: r.project_id,
      kind: 'routine_approval',
      url: `${base}/#paws`,
      age_ms: Math.max(0, now - (anchor ?? now)),
    })
  }

  const cards = safeAll<{ id: string; project_id: string; title: string; created_at: number }>(core, `
    SELECT id, project_id, title, created_at
      FROM action_items
     WHERE status = 'proposed' AND archived_at IS NULL AND created_at >= ?
     ORDER BY created_at ASC
  `, now - windowMs)
  for (const r of cards) {
    out.push({
      title: r.title,
      project_id: r.project_id,
      kind: 'card',
      url: `${base}/#action-plan`,
      age_ms: Math.max(0, now - r.created_at),
    })
  }

  return out.sort((a, b) => b.age_ms - a.age_ms)
}

/**
 * What each project did in the window (spec 5.2). One row per project that
 * actually did something; a silent project is left out so the digest stays
 * short.
 */
export function gatherProjectActivity(core: Db, telemetry: Db, windowMs: number): ProjectActivity[] {
  const from = Date.now() - windowMs
  const acc = new Map<string, ProjectActivity>()
  const row = (project_id: string): ProjectActivity => {
    let r = acc.get(project_id)
    if (!r) {
      r = { project_id, cycles: 0, cron_tasks_run: 0, cards_opened: 0, cards_shipped: 0, cost_usd: 0, failures: 0, note: '' }
      acc.set(project_id, r)
    }
    return r
  }

  for (const c of gatherCycleCounts(core, from)) {
    const r = row(c.project_id)
    r.cycles += c.n
    r.failures += c.failed ?? 0
  }

  for (const t of gatherCronRows(core, from)) {
    row(t.project_id).cron_tasks_run++
  }

  for (const a of safeAll<{ project_id: string; n: number }>(core, `
    SELECT project_id, COUNT(*) AS n FROM action_items
     WHERE created_at >= ? GROUP BY project_id
  `, from)) {
    row(a.project_id).cards_opened += a.n
  }

  for (const a of safeAll<{ project_id: string; n: number }>(core, `
    SELECT project_id, COUNT(*) AS n FROM action_items
     WHERE completed_at >= ? GROUP BY project_id
  `, from)) {
    row(a.project_id).cards_shipped += a.n
  }

  for (const e of safeAll<{ project_id: string; cost: number; errors: number }>(telemetry, `
    SELECT project_id, SUM(COALESCE(total_cost_usd, 0)) AS cost,
           SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS errors
      FROM agent_events WHERE agent_started_at >= ? GROUP BY project_id
  `, from)) {
    if (!e.project_id) continue
    const r = row(e.project_id)
    r.cost_usd += e.cost ?? 0
    r.failures += e.errors ?? 0
  }

  for (const r of acc.values()) {
    const parts: string[] = []
    if (r.cycles) parts.push(`${r.cycles} routine ${r.cycles === 1 ? 'cycle' : 'cycles'}`)
    if (r.cron_tasks_run) parts.push(`${r.cron_tasks_run} cron ${r.cron_tasks_run === 1 ? 'task' : 'tasks'} ran`)
    if (r.cards_shipped) parts.push(`${r.cards_shipped} card${r.cards_shipped === 1 ? '' : 's'} shipped`)
    if (r.failures) parts.push(`${r.failures} failure${r.failures === 1 ? '' : 's'}`)
    r.note = parts.join(', ') || 'no activity'
  }

  return [...acc.values()]
    .filter(r => r.cycles || r.cron_tasks_run || r.cards_opened || r.cards_shipped || r.cost_usd > 0)
    .sort((a, b) => b.cost_usd - a.cost_usd)
}
