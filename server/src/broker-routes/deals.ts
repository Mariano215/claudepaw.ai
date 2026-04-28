/**
 * broker-routes/deals.ts
 *
 * Two deal routes:
 *   GET  /api/v1/broker/deals               -- list (project-scoped, optional status filter)
 *   POST /api/v1/broker/deals/:id/move      -- editor mutation (status transition)
 *
 * No POST for deal creation -- deals come from the broker-listings collector
 * (broker-listings.ts under src/paws/collectors). Only the move action
 * mutates deals from the dashboard.
 *
 * Allowed transitions (forward-only with a passed escape hatch):
 *   sourced       -> under-review, passed
 *   under-review  -> under-contract, passed
 *   under-contract-> closed, passed
 *   closed        -> (terminal)
 *   passed        -> (terminal)
 */

import { Router, type Request, type Response } from 'express'
import { logger } from '../logger.js'
import { requireProjectRoleForResource } from '../routes.js'
import { serverDb } from './shared.js'

const router = Router()

interface DealRow {
  id: string
  project_id: string
  source_paw_id: string | null
  address: string
  zip: string | null
  list_price: number | null
  max_offer: number | null
  est_arv: number | null
  est_rehab: number | null
  est_rent_monthly: number | null
  est_str_adr: number | null
  est_str_occupancy: number | null
  est_cap_rate: number | null
  est_coc: number | null
  deal_type: string | null
  status: string
  severity: number | null
  notes: string | null
  created_at: number
  updated_at: number
}

const ALLOWED_STATUSES = ['sourced', 'under-review', 'under-contract', 'closed', 'passed'] as const
type DealStatus = typeof ALLOWED_STATUSES[number]

const TRANSITIONS: Record<DealStatus, readonly DealStatus[]> = {
  'sourced': ['under-review', 'passed'],
  'under-review': ['under-contract', 'passed'],
  'under-contract': ['closed', 'passed'],
  'closed': [],
  'passed': [],
}

router.get('/api/v1/broker/deals', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }

  const status = typeof req.query.status === 'string' ? req.query.status : null
  if (status && !ALLOWED_STATUSES.includes(status as DealStatus)) {
    res.status(400).json({ error: `status must be one of ${ALLOWED_STATUSES.join(', ')}` })
    return
  }

  try {
    const isAdmin = req.user?.isAdmin === true
    const allowed = req.scope?.allowedProjectIds
    const requested = typeof req.query.project_id === 'string' ? req.query.project_id : null

    const wheres: string[] = []
    const args: unknown[] = []

    if (isAdmin) {
      if (requested) {
        wheres.push('project_id = ?')
        args.push(requested)
      }
    } else {
      const pids = allowed ?? []
      if (pids.length === 0) {
        res.json({ deals: [] })
        return
      }
      wheres.push(`project_id IN (${pids.map(() => '?').join(',')})`)
      args.push(...pids)
    }

    if (status) {
      wheres.push('status = ?')
      args.push(status)
    }

    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
    const rows = db
      .prepare(`SELECT * FROM deals ${whereClause} ORDER BY severity DESC NULLS LAST, created_at DESC`)
      .all(...args) as DealRow[]
    res.json({ deals: rows })
  } catch (err) {
    logger.warn({ err }, 'broker: list deals failed')
    res.status(500).json({ error: 'failed to list deals' })
  }
})

router.post(
  '/api/v1/broker/deals/:id/move',
  requireProjectRoleForResource('editor', (id) => {
    const db = serverDb()
    if (!db) return null
    const row = db.prepare('SELECT project_id FROM deals WHERE id = ?').get(id) as { project_id: string } | undefined
    return row?.project_id ?? null
  }),
  (req: Request, res: Response) => {
    const db = serverDb()
    if (!db) {
      res.status(503).json({ error: 'database unavailable' })
      return
    }

    const id = String(req.params.id)
    const target = typeof req.body?.status === 'string' ? req.body.status : null
    if (!target || !ALLOWED_STATUSES.includes(target as DealStatus)) {
      res.status(400).json({ error: `status must be one of ${ALLOWED_STATUSES.join(', ')}` })
      return
    }

    try {
      const existing = db.prepare('SELECT id, status FROM deals WHERE id = ?').get(id) as { id: string; status: string } | undefined
      if (!existing) {
        res.status(404).json({ error: 'deal not found' })
        return
      }

      const current = existing.status as DealStatus
      const allowed = TRANSITIONS[current] ?? []
      if (current === target) {
        // No-op transition: still bump updated_at to record the click.
        db.prepare('UPDATE deals SET updated_at = ? WHERE id = ?').run(Date.now(), id)
        const row = db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as DealRow
        res.json({ deal: row })
        return
      }
      if (!allowed.includes(target as DealStatus)) {
        res.status(409).json({ error: `cannot move from ${current} to ${target}` })
        return
      }

      db.prepare('UPDATE deals SET status = ?, updated_at = ? WHERE id = ?').run(target, Date.now(), id)
      const row = db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as DealRow
      res.json({ deal: row })
    } catch (err) {
      logger.warn({ err, id }, 'broker: deal move failed')
      res.status(500).json({ error: 'failed to move deal' })
    }
  },
)

export default router
