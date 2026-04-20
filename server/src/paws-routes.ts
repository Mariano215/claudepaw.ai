import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import * as cronParserModule from 'cron-parser'
import { getDb, getBotDbWrite } from './db.js'

// cron-parser v4 uses parseExpression(), v5 uses CronExpressionParser.parse()
// Timezone pinned via CRON_TZ env var (default America/New_York) so DST and
// server-local TZ changes don't silently shift scheduled Paws.
const CRON_TZ = process.env.CRON_TZ || 'America/New_York'

function parseCron(expression: string): { next(): { getTime(): number } } {
  const mod = cronParserModule as any
  const opts = { tz: CRON_TZ }
  if (typeof mod.parseExpression === 'function') return mod.parseExpression(expression, opts)
  if (typeof mod.CronExpressionParser?.parse === 'function') return mod.CronExpressionParser.parse(expression, opts)
  if (typeof mod.default?.parseExpression === 'function') return mod.default.parseExpression(expression, opts)
  throw new Error('cron-parser API not found')
}

// Compute the next run time (ms) for a cron expression. Returns now+60s on
// parse failure so callers never get a stale/past next_run that would fire
// immediately and stampede on the next scheduler tick.
function computeNextRunMs(cron: string): number {
  try {
    return parseCron(cron).next().getTime()
  } catch {
    return Date.now() + 60_000
  }
}
import { broadcastToMac, broadcastPawsUpdate } from './ws.js'
import { logger } from './logger.js'
import {
  requireProjectRole,
  requireBotOrAdmin,
  scopeProjects,
} from './auth.js'
import { resolveProjectScope, requireProjectRoleForResource } from './routes.js'

const router = Router()

// ---------------------------------------------------------------------------
// Scope middleware
// ---------------------------------------------------------------------------
// paws-routes are registered with app.use(pawsRoutes) (no prefix). The global
// authenticate + scopeProjects middleware in index.ts already runs on
// /api/v1/* before this router, so req.user and req.scope are populated.
// The scopeProjects fallback here handles tests that mount paws-routes directly
// without the global middleware chain.
router.use('/api/v1/paws', (req: Request, res: Response, next: NextFunction) => {
  if (req.scope) {
    next()
    return
  }
  scopeProjects(req, res, next)
})
router.use('/api/v1/internal/paws-sync', (req: Request, res: Response, next: NextFunction) => {
  if (req.scope) {
    next()
    return
  }
  scopeProjects(req, res, next)
})

// ---------------------------------------------------------------------------
// Helper: resolve a paw's project_id from its ID.
// Returns null when the paw does not exist -- requireProjectRoleForResource
// converts that to 404.
// ---------------------------------------------------------------------------
function getPawProjectId(id: string): string | null {
  const row = getDb().prepare('SELECT project_id FROM paws WHERE id = ?').get(id) as { project_id: string } | undefined
  return row?.project_id ?? null
}

// ---------------------------------------------------------------------------
// GET /api/v1/paws?project_id=xxx
// List -- filtered to caller's allowed projects.
// ---------------------------------------------------------------------------
router.get('/api/v1/paws', (req: Request, res: Response) => {
  try {
    const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
    const db = getDb()

    let rows: unknown[]
    if (requestedProjectId) {
      rows = db.prepare('SELECT * FROM paws WHERE project_id = ? ORDER BY created_at DESC').all(requestedProjectId)
    } else if (allowedProjectIds === null) {
      // admin bypass -- no filter
      rows = db.prepare('SELECT * FROM paws ORDER BY created_at DESC').all()
    } else if (allowedProjectIds.length === 0) {
      rows = []
    } else {
      const ph = allowedProjectIds.map(() => '?').join(', ')
      rows = db.prepare(`SELECT * FROM paws WHERE project_id IN (${ph}) ORDER BY created_at DESC`).all(...allowedProjectIds)
    }

    const paws = (rows as any[]).map(r => ({ ...r, config: JSON.parse(r.config) }))
    res.json({ ok: true, paws })
  } catch (err) {
    logger.error({ err }, 'GET /paws error')
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
})

// ---------------------------------------------------------------------------
// GET /api/v1/paws/:id
// Single read -- viewer role required for the paw's project.
// ---------------------------------------------------------------------------
router.get(
  '/api/v1/paws/:id',
  requireProjectRoleForResource('viewer', getPawProjectId),
  (req: Request, res: Response) => {
    try {
      const db = getDb()
      const row = db.prepare('SELECT * FROM paws WHERE id = ?').get(req.params.id) as any
      if (!row) {
        res.status(404).json({ ok: false, error: 'Paw not found' })
        return
      }
      const paw = { ...row, config: JSON.parse(row.config) }
      const latestCycle = db.prepare(
        'SELECT * FROM paw_cycles WHERE paw_id = ? ORDER BY started_at DESC LIMIT 1'
      ).get(req.params.id) as any
      let latest_cycle = null
      if (latestCycle) {
        latest_cycle = {
          ...latestCycle,
          state: JSON.parse(latestCycle.state),
          findings: JSON.parse(latestCycle.findings),
          actions_taken: JSON.parse(latestCycle.actions_taken),
        }
      }
      res.json({ ok: true, paw, latest_cycle })
    } catch (err) {
      logger.error({ err }, 'GET /paws/:id error')
      res.status(500).json({ ok: false, error: 'Internal server error' })
    }
  },
)

// ---------------------------------------------------------------------------
// GET /api/v1/paws/:id/cycles?limit=20
// Single read -- viewer role required for the paw's project.
// ---------------------------------------------------------------------------
router.get(
  '/api/v1/paws/:id/cycles',
  requireProjectRoleForResource('viewer', getPawProjectId),
  (req: Request, res: Response) => {
    try {
      const db = getDb()
      const limit = parseInt(req.query.limit as string) || 20
      const rows = db.prepare(
        'SELECT * FROM paw_cycles WHERE paw_id = ? ORDER BY started_at DESC LIMIT ?'
      ).all(req.params.id, limit) as any[]
      const cycles = rows.map(r => ({
        ...r,
        state: JSON.parse(r.state),
        findings: JSON.parse(r.findings),
        actions_taken: JSON.parse(r.actions_taken),
      }))
      res.json({ ok: true, cycles })
    } catch (err) {
      logger.error({ err }, 'GET /paws/:id/cycles error')
      res.status(500).json({ ok: false, error: 'Internal server error' })
    }
  },
)

// ---------------------------------------------------------------------------
// POST /api/v1/paws
// Create -- editor role required for the target project (from body.project_id).
// ---------------------------------------------------------------------------
router.post(
  '/api/v1/paws',
  requireProjectRole('editor', req => req.body?.project_id ?? null),
  (req: Request, res: Response) => {
    try {
      const { id, name, agent_id, cron, project_id, config } = req.body as {
        id?: string; name?: string; agent_id?: string; cron?: string; project_id?: string
        config?: { chat_id?: string; approval_threshold?: number; approval_timeout_sec?: number; phase_instructions?: Record<string, string> }
      }
      if (!id || !name || !agent_id || !cron) {
        res.status(400).json({ ok: false, error: 'id, name, agent_id, and cron are required' })
        return
      }
      try {
        const interval = parseCron(cron)
        const t1 = interval.next().getTime()
        const t2 = interval.next().getTime()
        if (t2 - t1 < 5 * 60 * 1000) {
          res.status(400).json({ ok: false, error: 'Cron schedule must have a minimum interval of 5 minutes' })
          return
        }
      } catch {
        res.status(400).json({ ok: false, error: 'Invalid cron expression' })
        return
      }
      if (config?.approval_threshold !== undefined) {
        const threshold = Number(config.approval_threshold)
        if (isNaN(threshold) || threshold < 1 || threshold > 5) {
          return res.status(400).json({ error: 'approval_threshold must be between 1 and 5' })
        }
        config.approval_threshold = threshold
      }
      const db = getDb()
      const existing = db.prepare('SELECT id FROM paws WHERE id = ?').get(id)
      if (existing) {
        res.status(409).json({ ok: false, error: 'Paw with this ID already exists' })
        return
      }
      const pawConfig = {
        chat_id: config?.chat_id || '',
        approval_threshold: config?.approval_threshold ?? 3,
        approval_timeout_sec: config?.approval_timeout_sec ?? 3600,
        phase_instructions: config?.phase_instructions || {},
      }
      const nextRun = computeNextRunMs(cron)
      db.prepare(`
        INSERT INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(id, project_id || 'default', name, agent_id, cron, JSON.stringify(pawConfig), nextRun, Date.now())

      broadcastToMac({ type: 'paw-created', pawId: id, data: { id, name, agent_id, cron, project_id: project_id || 'default', config: pawConfig } })
      broadcastPawsUpdate(project_id || 'default')
      res.json({ ok: true, id })
    } catch (err) {
      logger.error({ err }, 'POST /paws error')
      res.status(500).json({ ok: false, error: 'Internal server error' })
    }
  },
)

// ---------------------------------------------------------------------------
// PUT /api/v1/paws/:id
// Update -- editor role required for the paw's project.
// ---------------------------------------------------------------------------
router.put(
  '/api/v1/paws/:id',
  requireProjectRoleForResource('editor', getPawProjectId),
  (req: Request, res: Response) => {
    try {
      const db = getDb()
      const row = db.prepare('SELECT * FROM paws WHERE id = ?').get(req.params.id) as any
      if (!row) {
        res.status(404).json({ ok: false, error: 'Paw not found' })
        return
      }
      const { name, agent_id, cron, config } = req.body as {
        name?: string; agent_id?: string; cron?: string
        config?: { chat_id?: string; approval_threshold?: number; approval_timeout_sec?: number; phase_instructions?: Record<string, string> }
      }
      const sets: string[] = []
      const values: unknown[] = []
      if (name !== undefined) { sets.push('name = ?'); values.push(name) }
      if (agent_id !== undefined) { sets.push('agent_id = ?'); values.push(agent_id) }
      if (cron !== undefined) {
        try {
          const interval = parseCron(cron)
          const t1 = interval.next().getTime()
          const t2 = interval.next().getTime()
          if (t2 - t1 < 5 * 60 * 1000) {
            res.status(400).json({ ok: false, error: 'Cron schedule must have a minimum interval of 5 minutes' })
            return
          }
        } catch {
          res.status(400).json({ ok: false, error: 'Invalid cron expression' })
          return
        }
        sets.push('cron = ?')
        values.push(cron)
      }
      if (config !== undefined) {
        if (config.approval_threshold !== undefined) {
          const threshold = Number(config.approval_threshold)
          if (isNaN(threshold) || threshold < 1 || threshold > 5) {
            return res.status(400).json({ error: 'approval_threshold must be between 1 and 5' })
          }
          config.approval_threshold = threshold
        }
        const existingConfig = JSON.parse(row.config || '{}')
        const merged = { ...existingConfig, ...config }
        sets.push('config = ?')
        values.push(JSON.stringify(merged))
      }
      if (sets.length === 0) {
        res.status(400).json({ ok: false, error: 'No valid fields to update' })
        return
      }
      values.push(req.params.id)
      db.prepare(`UPDATE paws SET ${sets.join(', ')} WHERE id = ?`).run(...values)

      broadcastToMac({ type: 'paw-updated', pawId: req.params.id, data: { name, agent_id, cron, config } })
      broadcastPawsUpdate(row.project_id || 'default')
      res.json({ ok: true, id: req.params.id })
    } catch (err) {
      logger.error({ err }, 'PUT /paws/:id error')
      res.status(500).json({ ok: false, error: 'Internal server error' })
    }
  },
)

// ---------------------------------------------------------------------------
// POST /api/v1/paws/:id/pause
// Mutation -- editor role required.
// ---------------------------------------------------------------------------
router.post(
  '/api/v1/paws/:id/pause',
  requireProjectRoleForResource('editor', getPawProjectId),
  (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const result = getDb().prepare("UPDATE paws SET status = 'paused' WHERE id = ?").run(id)
      if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Paw not found' })
      // Clean up any pending approval cycles. `paw_cycles` has no
      // `updated_at` or `approval_requested` columns -- approval_requested
      // lives inside the JSON `state` column. Match it via json_extract and
      // don't touch the non-existent column.
      try {
        const bdb = getBotDbWrite()
        if (bdb) {
          bdb.prepare(`
            UPDATE paw_cycles
               SET phase = 'failed',
                   error = 'paw paused before approval',
                   completed_at = ?
             WHERE paw_id = ?
               AND phase = 'decide'
               AND json_extract(state, '$.approval_requested') = 1
          `).run(Date.now(), id)
        }
      } catch (err) { logger.warn({ err, pawId: id }, 'pause: failed to close pending approval cycle') }
      res.json({ ok: true })
    } catch (err) {
      logger.error({ err }, 'POST /paws/:id/pause error')
      res.status(500).json({ ok: false, error: 'Internal server error' })
    }
  },
)

// ---------------------------------------------------------------------------
// POST /api/v1/paws/:id/resume
// Mutation -- editor role required.
// ---------------------------------------------------------------------------
router.post(
  '/api/v1/paws/:id/resume',
  requireProjectRoleForResource('editor', getPawProjectId),
  (req: Request, res: Response) => {
    try {
      const db = getDb()
      const row = db.prepare('SELECT cron FROM paws WHERE id = ?').get(req.params.id) as { cron?: string } | undefined
      if (!row) return res.status(404).json({ ok: false, error: 'Paw not found' })
      // Recompute next_run so a long pause doesn't leave a stale timestamp
      // that fires the Paw immediately (and as part of a backlog burst) on
      // the next scheduler tick.
      const nextRun = row.cron ? computeNextRunMs(row.cron) : Date.now() + 60_000
      const result = db.prepare("UPDATE paws SET status = 'active', next_run = ? WHERE id = ?").run(nextRun, req.params.id)
      if (result.changes === 0) return res.status(404).json({ ok: false, error: 'Paw not found' })
      res.json({ ok: true, next_run: nextRun })
    } catch (err) {
      logger.error({ err }, 'POST /paws/:id/resume error')
      res.status(500).json({ ok: false, error: 'Internal server error' })
    }
  },
)

// ---------------------------------------------------------------------------
// POST /api/v1/paws/:id/approve
// Approval/skip action -- editor minimum (same level as all other mutations).
// ---------------------------------------------------------------------------
router.post(
  '/api/v1/paws/:id/approve',
  requireProjectRoleForResource('editor', getPawProjectId),
  (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const { approved } = req.body as { approved?: boolean }
      if (typeof approved !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'approved (boolean) is required' })
      }
      const db = getDb()
      const row = db.prepare('SELECT * FROM paws WHERE id = ?').get(id) as any
      if (!row) {
        return res.status(404).json({ ok: false, error: 'Paw not found' })
      }
      if (row.status !== 'waiting_approval') {
        return res.status(409).json({ ok: false, error: 'Paw is not waiting for approval' })
      }
      broadcastToMac({ type: 'paw-approve', pawId: id, approved })
      broadcastPawsUpdate(row.project_id || 'default')
      res.json({ ok: true, message: approved ? 'Approval sent' : 'Skip sent' })
    } catch (err) {
      logger.error({ err }, 'POST /paws/:id/approve error')
      res.status(500).json({ ok: false, error: 'Internal server error' })
    }
  },
)

// ---------------------------------------------------------------------------
// POST /api/v1/paws/:id/run-now
// Trigger a cycle -- editor minimum.
// ---------------------------------------------------------------------------
router.post(
  '/api/v1/paws/:id/run-now',
  requireProjectRoleForResource('editor', getPawProjectId),
  (req: Request, res: Response) => {
    try {
      const db = getDb()
      const row = db.prepare('SELECT * FROM paws WHERE id = ?').get(req.params.id) as any
      if (!row) {
        res.status(404).json({ ok: false, error: 'Paw not found' })
        return
      }
      broadcastToMac({ type: 'run-paw', pawId: req.params.id })
      res.json({ ok: true, message: 'Run triggered' })
    } catch (err) {
      logger.error({ err }, 'POST /paws/:id/run-now error')
      res.status(500).json({ ok: false, error: 'Internal server error' })
    }
  },
)

// ---------------------------------------------------------------------------
// DELETE /api/v1/paws/:id
// Mutation -- editor role required.
// ---------------------------------------------------------------------------
router.delete(
  '/api/v1/paws/:id',
  requireProjectRoleForResource('editor', getPawProjectId),
  (req: Request, res: Response) => {
    try {
      const db = getDb()
      const row = db.prepare('SELECT project_id FROM paws WHERE id = ?').get(req.params.id) as any
      const projectId = row?.project_id || 'default'
      db.prepare('DELETE FROM paw_cycles WHERE paw_id = ?').run(req.params.id)
      db.prepare('DELETE FROM paws WHERE id = ?').run(req.params.id)
      broadcastToMac({ type: 'paw-deleted', pawId: req.params.id })
      broadcastPawsUpdate(projectId)
      res.json({ ok: true })
    } catch (err) {
      logger.error({ err }, 'DELETE /paws/:id error')
      res.status(500).json({ ok: false, error: 'Internal server error' })
    }
  },
)

// ---------------------------------------------------------------------------
// POST /api/v1/internal/paws-sync (bot pushes state here)
// ---------------------------------------------------------------------------
router.post('/api/v1/internal/paws-sync', requireBotOrAdmin, (req: Request, res: Response) => {
  try {
    const { paws, cycles } = req.body
    if (!Array.isArray(paws)) return res.status(400).json({ ok: false, error: 'paws must be an array' })
    const db = getDb()
    const upsertPaw = db.prepare(`
      INSERT OR REPLACE INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const paw of paws) {
      upsertPaw.run(paw.id, paw.project_id, paw.name, paw.agent_id, paw.cron, paw.status,
        typeof paw.config === 'string' ? paw.config : JSON.stringify(paw.config),
        paw.next_run, paw.created_at)
    }
    // Sync latest cycle data so the dashboard can show findings and approval context
    if (Array.isArray(cycles)) {
      const upsertCycle = db.prepare(`
        INSERT OR REPLACE INTO paw_cycles (id, paw_id, started_at, phase, state, findings, actions_taken, report, completed_at, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const c of cycles) {
        upsertCycle.run(c.id, c.paw_id, c.started_at, c.phase,
          typeof c.state === 'string' ? c.state : JSON.stringify(c.state),
          typeof c.findings === 'string' ? c.findings : JSON.stringify(c.findings),
          typeof c.actions_taken === 'string' ? c.actions_taken : JSON.stringify(c.actions_taken),
          c.report ?? null, c.completed_at ?? null, c.error ?? null)
      }
    }
    res.json({ ok: true })
  } catch (err) {
    logger.error({ err }, 'POST /internal/paws-sync error')
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
})

export default router
