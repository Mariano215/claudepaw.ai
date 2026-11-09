import { getDb } from '../db.js'
import { type Budget } from './budget.js'
import { logger } from '../logger.js'

const CACHE_TTL_MS = 30_000
const cache = new Map<string, { snapshot: string; expiresAt: number }>()

export async function buildProjectSnapshot(projectId: string, budget: Budget): Promise<string> {
  const c = cache.get(projectId)
  if (c && c.expiresAt > Date.now()) {
    budget.consumeText(c.snapshot)
    return c.snapshot
  }
  try {
    const s = await assemble(projectId)
    cache.set(projectId, { snapshot: s, expiresAt: Date.now() + CACHE_TTL_MS })
    budget.consumeText(s)
    return s
  } catch (err) {
    logger.warn({ err, projectId }, 'snapshot failed')
    return ''
  }
}

export function _clearSnapshotCache(): void {
  cache.clear()
}

async function assemble(projectId: string): Promise<string> {
  const db = getDb()
  const p = db.prepare('SELECT id, name, display_name FROM projects WHERE id = ?').get(projectId) as
    | { id: string; name: string; display_name: string | null }
    | undefined
  if (!p) return ''

  const parts = [`[Project: ${p.display_name ?? p.name}]`]

  try {
    const items = db.prepare(`
      SELECT title, priority FROM action_items
      WHERE project_id = ? AND status IN ('proposed','approved')
      ORDER BY CASE priority
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        ELSE 3
      END, updated_at DESC
      LIMIT 5
    `).all(projectId) as Array<{ title: string; priority: string | null }>
    const total = (
      db.prepare(
        `SELECT COUNT(*) c FROM action_items WHERE project_id = ? AND status IN ('proposed','approved')`,
      ).get(projectId) as { c: number }
    ).c
    if (total > 0) {
      const lines = [`[Open action items: ${total}]`]
      for (const a of items) lines.push(`  - (${a.priority ?? 'medium'}) ${a.title}`)
      parts.push(lines.join('\n'))
    }
  } catch (err) {
    logger.debug({ err }, 'action_items skipped')
  }

  try {
    const paws = db.prepare(`
      SELECT p.name AS name, (
        SELECT pc.report FROM paw_cycles pc
        WHERE pc.paw_id = p.id AND pc.report IS NOT NULL
        ORDER BY pc.started_at DESC LIMIT 1
      ) AS last_cycle_summary
      FROM paws p
      WHERE p.project_id = ? AND p.status != 'paused'
      ORDER BY p.created_at DESC
      LIMIT 5
    `).all(projectId) as Array<{ name: string; last_cycle_summary: string | null }>
    if (paws.length > 0) {
      const lines = [`[Active paws: ${paws.length}]`]
      for (const p of paws) lines.push(`  - ${p.name}: ${(p.last_cycle_summary ?? 'no recent cycle').slice(0, 80)}`)
      parts.push(lines.join('\n'))
    }
  } catch (err) {
    logger.debug({ err }, 'paws skipped')
  }

  try {
    const dec = db.prepare(`
      SELECT description FROM board_decisions
      WHERE meeting_id IN (SELECT id FROM board_meetings WHERE project_id = ?) AND status = 'pending'
      ORDER BY id DESC LIMIT 3
    `).all(projectId) as Array<{ description: string }>
    if (dec.length > 0) {
      const lines = ['[Pending decisions]']
      for (const d of dec) lines.push(`  - ${d.description}`)
      parts.push(lines.join('\n'))
    }
  } catch (err) {
    logger.debug({ err }, 'decisions skipped')
  }

  return parts.join('\n\n')
}
