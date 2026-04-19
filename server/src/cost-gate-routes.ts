/**
 * cost-gate-routes.ts
 *
 * Cost-gate status and cap-update endpoints mounted under /api/v1/cost-gate.
 *
 * Authorization:
 *   GET  /:projectId       -- requireProjectRead (any project member or admin)
 *   PUT  /:projectId/caps  -- requireProjectRole('editor') (editor or owner or admin)
 *
 * The global /api/v1 pipeline (index.ts) runs `authenticate` then
 * `scopeProjects` before this router, so `req.user` is always populated.
 */

import { Router, type Request, type Response } from 'express'
import { requireProjectRead, requireProjectRole } from './auth.js'
import { getProjectSettingsById, upsertProjectSettingsInDb } from './db.js'
import { computeCostGateStatus } from './cost-gate.js'
import { logger } from './logger.js'

const router = Router()

// ---------------------------------------------------------------------------
// GET /:projectId -- return current CostGateStatus
// ---------------------------------------------------------------------------

router.get(
  '/:projectId',
  requireProjectRead('projectId'),
  (req: Request, res: Response): void => {
    const projectId = String(req.params.projectId)

    const settings = getProjectSettingsById(projectId)
    const caps = {
      monthly_cost_cap_usd: settings?.monthly_cost_cap_usd ?? null,
      daily_cost_cap_usd: settings?.daily_cost_cap_usd ?? null,
    }

    try {
      const status = computeCostGateStatus(projectId, caps)
      res.json(status)
    } catch (err) {
      logger.warn({ err, projectId }, 'cost-gate GET failed')
      res.status(500).json({ error: 'Failed to compute cost gate status' })
    }
  },
)

// ---------------------------------------------------------------------------
// PUT /:projectId/caps -- update monthly/daily cost caps
// ---------------------------------------------------------------------------

router.put(
  '/:projectId/caps',
  requireProjectRole('editor', (r) => String(r.params.projectId)),
  (req: Request, res: Response): void => {
    const projectId = String(req.params.projectId)
    const { monthly_cost_cap_usd, daily_cost_cap_usd } = req.body as {
      monthly_cost_cap_usd?: number | null
      daily_cost_cap_usd?: number | null
    }

    // Validate: each provided value must be null or a finite non-negative number.
    // Number.isFinite rejects NaN and Infinity, which typeof 'number' otherwise admits.
    if (monthly_cost_cap_usd !== undefined && monthly_cost_cap_usd !== null) {
      if (!Number.isFinite(monthly_cost_cap_usd) || monthly_cost_cap_usd < 0) {
        res.status(400).json({ error: 'monthly_cost_cap_usd must be a non-negative number or null' })
        return
      }
    }
    if (daily_cost_cap_usd !== undefined && daily_cost_cap_usd !== null) {
      if (!Number.isFinite(daily_cost_cap_usd) || daily_cost_cap_usd < 0) {
        res.status(400).json({ error: 'daily_cost_cap_usd must be a non-negative number or null' })
        return
      }
    }

    const update: {
      project_id: string
      monthly_cost_cap_usd?: number | null
      daily_cost_cap_usd?: number | null
    } = { project_id: projectId }

    if (monthly_cost_cap_usd !== undefined) update.monthly_cost_cap_usd = monthly_cost_cap_usd
    if (daily_cost_cap_usd !== undefined) update.daily_cost_cap_usd = daily_cost_cap_usd

    try {
      upsertProjectSettingsInDb(update)
    } catch (err) {
      logger.warn({ err, projectId }, 'cost-gate PUT failed to persist caps')
      res.status(500).json({ error: 'Failed to persist cost caps' })
      return
    }

    // Read back the persisted row so the response reflects actual DB state,
    // not just the fields sent in the request body. This matters when the
    // caller sends only one cap (e.g. { daily_cost_cap_usd: 5 }) -- the
    // upsert has PATCH semantics and leaves the other cap intact; we must
    // return that intact value rather than null.
    const persisted = getProjectSettingsById(projectId)
    res.json({
      monthly_cost_cap_usd: persisted?.monthly_cost_cap_usd ?? null,
      daily_cost_cap_usd: persisted?.daily_cost_cap_usd ?? null,
    })
  },
)

export default router
