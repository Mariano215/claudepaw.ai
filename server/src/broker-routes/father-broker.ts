/**
 * broker-routes/father-broker.ts
 *
 * Two routes for the father-broker inbox (off-market deal flow):
 *   GET  /api/v1/broker/father-broker-listings           -- list, optional status filter
 *   POST /api/v1/broker/father-broker-listings/:id/status -- editor mutation
 *
 * Status transitions are open: any allowed value is reachable from any
 * other one (a listing can flip back to 'reviewed' after being marked
 * 'pursued' if the deal falls through, etc).
 */

import { Router, type Request, type Response } from 'express'
import { logger } from '../logger.js'
import { requireProjectRoleForResource } from '../routes.js'
import { serverDb } from './shared.js'

const router = Router()

interface FatherListingRow {
  id: string
  project_id: string
  address: string
  zip: string | null
  list_price: number | null
  off_market: number
  source: string | null
  notes: string | null
  received_at: number
  status: string
  created_at: number
}

const ALLOWED_STATUSES = ['new', 'reviewed', 'passed', 'pursued'] as const

router.get('/api/v1/broker/father-broker-listings', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }

  const status = typeof req.query.status === 'string' ? req.query.status : null
  if (status && !ALLOWED_STATUSES.includes(status as typeof ALLOWED_STATUSES[number])) {
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
        res.json({ listings: [] })
        return
      }
      wheres.push(`project_id IN (${pids.map(() => '?').join(',')})`)
      args.push(...pids)
    }

    if (status) {
      wheres.push('status = ?')
      args.push(status)
    }

    const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
    const rows = db
      .prepare(`SELECT * FROM father_broker_listings ${where} ORDER BY received_at DESC`)
      .all(...args) as FatherListingRow[]
    res.json({ listings: rows })
  } catch (err) {
    logger.warn({ err }, 'broker: list father-broker-listings failed')
    res.status(500).json({ error: 'failed to list father broker listings' })
  }
})

router.post(
  '/api/v1/broker/father-broker-listings/:id/status',
  requireProjectRoleForResource('editor', (id) => {
    const db = serverDb()
    if (!db) return null
    const row = db
      .prepare('SELECT project_id FROM father_broker_listings WHERE id = ?')
      .get(id) as { project_id: string } | undefined
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
    if (!target || !ALLOWED_STATUSES.includes(target as typeof ALLOWED_STATUSES[number])) {
      res.status(400).json({ error: `status must be one of ${ALLOWED_STATUSES.join(', ')}` })
      return
    }

    try {
      const result = db
        .prepare('UPDATE father_broker_listings SET status = ? WHERE id = ?')
        .run(target, id)
      if (result.changes === 0) {
        res.status(404).json({ error: 'listing not found' })
        return
      }
      const row = db.prepare('SELECT * FROM father_broker_listings WHERE id = ?').get(id) as FatherListingRow
      res.json({ listing: row })
    } catch (err) {
      logger.warn({ err, id }, 'broker: father-broker status update failed')
      res.status(500).json({ error: 'failed to update listing status' })
    }
  },
)

export default router
