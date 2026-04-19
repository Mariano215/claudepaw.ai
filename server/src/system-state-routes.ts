/**
 * system-state-routes.ts
 *
 * Kill-switch CRUD endpoints mounted under /api/v1/system-state.
 *
 * Authorization:
 *   GET  /kill-switch  -- any authenticated user (read-only)
 *   POST /kill-switch  -- admin only
 *   DELETE /kill-switch -- admin only
 *
 * The global /api/v1 pipeline (index.ts) runs `authenticate` then
 * `scopeProjects` before this router, so `req.user` is always populated.
 */

import { Router, type Request, type Response } from 'express'
import { requireAdmin } from './auth.js'
import { getKillSwitch, setKillSwitch, clearKillSwitch } from './system-state.js'
import { logger } from './logger.js'

const router = Router()

const REASON_MAX_LEN = 500

// ---------------------------------------------------------------------------
// GET /kill-switch -- any authed user
// ---------------------------------------------------------------------------

router.get('/kill-switch', (req: Request, res: Response): void => {
  const ks = getKillSwitch()
  if (!ks) {
    res.json({ active: false })
    return
  }
  res.json({
    active: true,
    set_at: ks.set_at,
    reason: ks.reason,
    set_by: ks.set_by,
  })
})

// ---------------------------------------------------------------------------
// POST /kill-switch -- admin only
// ---------------------------------------------------------------------------

router.post('/kill-switch', requireAdmin, (req: Request, res: Response): void => {
  const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''

  if (!rawReason) {
    res.status(400).json({ error: 'reason is required and must be non-empty' })
    return
  }

  const reason = rawReason.slice(0, REASON_MAX_LEN)
  const setBy = req.user!.email

  try {
    setKillSwitch(reason, setBy)
  } catch (err) {
    logger.warn({ err }, 'kill-switch POST failed: system_state store not initialized')
    res.status(500).json({ error: 'kill-switch store not initialized' })
    return
  }

  res.json({ active: true, reason })
})

// ---------------------------------------------------------------------------
// DELETE /kill-switch -- admin only
// ---------------------------------------------------------------------------

router.delete('/kill-switch', requireAdmin, (_req: Request, res: Response): void => {
  try {
    clearKillSwitch()
  } catch (err) {
    logger.warn({ err }, 'kill-switch DELETE failed: system_state store not initialized')
    res.status(500).json({ error: 'kill-switch store not initialized' })
    return
  }
  res.json({ active: false })
})

export default router
