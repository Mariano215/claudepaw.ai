/**
 * memory-routes.ts
 *
 * Observability endpoints for Memory V2 (Task 20).
 * Mounted under /api/v1/memory.
 *
 * Authorization strategy (adapted from the plan to fit the existing middleware):
 *   - The global /api/v1 pipeline (index.ts) runs `authenticate` then
 *     `scopeProjects`, so `req.user` and `req.scope` are always populated here.
 *   - `GET /stats` accepts ?project_id=xxx in the query string. We enforce
 *     membership via `req.scope.allowedProjectIds` (admins bypass). The plan
 *     originally wired `requireProjectRead('project_id')`, but that middleware
 *     only reads URL path params -- so we inline the check against the scope.
 *   - `GET /last-extraction-run` and `GET /recent-extraction-runs` are
 *     admin-only: extraction_runs is a cross-project operational log.
 *
 * DB access: the memory-v2 tables (entities, observations, chat_messages,
 * chat_summaries, extraction_runs) live in the bot's claudepaw.db. The server
 * tsconfig has rootDir=src so we cannot import from ../../src/db.js. Instead we
 * use the server's `getBotDb()` helper, which opens the same sqlite file in
 * readonly mode. If the bot DB is unavailable, we return 503; if a specific
 * table has not been created yet (bot started on older schema), we return 0
 * counts / null rather than surfacing the SQLITE_ERROR.
 */

import { Router, type Request, type Response } from 'express'
import type Database from 'better-sqlite3'
import { requireAdmin } from './auth.js'
import { getBotDb } from './db.js'
import { logger } from './logger.js'

const router = Router()

// ---------------------------------------------------------------------------
// Table existence cache
//
// The bot creates these tables on init; the dashboard opens the DB readonly
// and may boot before the bot has migrated. Cache per-table readiness so we
// don't hit sqlite_master on every request once we've confirmed existence.
// ---------------------------------------------------------------------------

const tableReady = new Map<string, boolean>()

function hasTable(db: Database.Database, name: string): boolean {
  const cached = tableReady.get(name)
  if (cached === true) return true
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name)
    const present = Boolean(row)
    if (present) tableReady.set(name, true)
    return present
  } catch {
    return false
  }
}

function countScopedByProject(
  db: Database.Database,
  table: string,
  projectId: string,
  nullable: boolean,
): number {
  if (!hasTable(db, table)) return 0
  try {
    const sql = nullable
      ? `SELECT COUNT(*) c FROM ${table} WHERE project_id = ? OR project_id IS NULL`
      : `SELECT COUNT(*) c FROM ${table} WHERE project_id = ?`
    const row = db.prepare(sql).get(projectId) as { c: number } | undefined
    return row?.c ?? 0
  } catch (err) {
    logger.warn({ err, table }, 'memory-routes: count query failed')
    return 0
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/memory/stats?project_id=xxx
//
// Counts of memory-v2 primitives scoped to the given project.
// ---------------------------------------------------------------------------
router.get('/stats', (req: Request, res: Response) => {
  const raw = req.query.project_id
  const projectId = typeof raw === 'string' ? raw.trim() : ''
  if (!projectId) {
    res.status(400).json({ error: 'project_id required' })
    return
  }

  // Authorization: admins pass through; members must have the project in
  // their allowed set. scopeProjects middleware has already run.
  const scope = req.scope
  if (!scope) {
    res.status(500).json({ error: 'scope not resolved' })
    return
  }
  if (!scope.isAdmin) {
    const allowed = scope.allowedProjectIds ?? []
    if (!allowed.includes(projectId)) {
      // 404 -- do not leak project existence
      res.status(404).json({ error: 'Not found' })
      return
    }
  }

  const db = getBotDb()
  if (!db) {
    res.status(503).json({ error: 'bot db unavailable' })
    return
  }

  res.json({
    entities: countScopedByProject(db, 'entities', projectId, true),
    observations: countScopedByProject(db, 'observations', projectId, true),
    chatMessages: countScopedByProject(db, 'chat_messages', projectId, false),
    chatSummaries: countScopedByProject(db, 'chat_summaries', projectId, false),
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/memory/last-extraction-run
//
// Admin-only: cross-project operational log.
// ---------------------------------------------------------------------------
router.get('/last-extraction-run', requireAdmin, (_req: Request, res: Response) => {
  const db = getBotDb()
  if (!db) {
    res.status(503).json({ error: 'bot db unavailable' })
    return
  }
  if (!hasTable(db, 'extraction_runs')) {
    res.json(null)
    return
  }
  try {
    const row = db
      .prepare(`SELECT * FROM extraction_runs ORDER BY started_at DESC LIMIT 1`)
      .get()
    res.json(row ?? null)
  } catch (err) {
    logger.warn({ err }, 'memory-routes: last-extraction-run query failed')
    res.json(null)
  }
})

// ---------------------------------------------------------------------------
// GET /api/v1/memory/recent-extraction-runs
//
// Admin-only: last 20 runs of any extraction tier.
// ---------------------------------------------------------------------------
router.get('/recent-extraction-runs', requireAdmin, (_req: Request, res: Response) => {
  const db = getBotDb()
  if (!db) {
    res.status(503).json({ error: 'bot db unavailable' })
    return
  }
  if (!hasTable(db, 'extraction_runs')) {
    res.json([])
    return
  }
  try {
    const rows = db
      .prepare(`SELECT * FROM extraction_runs ORDER BY started_at DESC LIMIT 20`)
      .all()
    res.json(rows)
  } catch (err) {
    logger.warn({ err }, 'memory-routes: recent-extraction-runs query failed')
    res.json([])
  }
})

export default router
