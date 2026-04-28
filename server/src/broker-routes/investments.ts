/**
 * broker-routes/investments.ts
 *
 * Full CRUD on the non-RE asset log:
 *   GET    /api/v1/broker/investments
 *   POST   /api/v1/broker/investments
 *   PUT    /api/v1/broker/investments/:id
 *   DELETE /api/v1/broker/investments/:id
 *
 * The `investments` table is a manual-entry-only asset log (stocks, ETFs,
 * crypto, retirement accounts, cash). Excluded from the OSS mirror via
 * the sanitizer.
 *
 * All mutations are gated to editor role. Project scope follows the same
 * three-state convention as the other broker routes.
 */

import { Router, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger.js'
import { requireProjectRole } from '../auth.js'
import { requireProjectRoleForResource } from '../routes.js'
import { serverDb } from './shared.js'

const router = Router()

interface InvestmentRow {
  id: string
  project_id: string
  asset_type: string
  account_label: string | null
  symbol: string | null
  quantity: number | null
  value_usd: number | null
  as_of: string | null
  notes: string | null
  created_at: number
  updated_at: number
}

const ALLOWED_ASSET_TYPES = [
  'stock', 'etf', 'bond', 'crypto',
  'retirement_401k', 'retirement_ira', 'retirement_solo_401k', 'retirement_sdira',
  'cash', 'hysa', 'treasury', 'other',
] as const

router.get('/api/v1/broker/investments', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
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
        res.json({ investments: [] })
        return
      }
      wheres.push(`project_id IN (${pids.map(() => '?').join(',')})`)
      args.push(...pids)
    }

    const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
    const rows = db
      .prepare(`SELECT * FROM investments ${where} ORDER BY as_of DESC NULLS LAST, updated_at DESC`)
      .all(...args) as InvestmentRow[]
    res.json({ investments: rows })
  } catch (err) {
    logger.warn({ err }, 'broker: list investments failed')
    res.status(500).json({ error: 'failed to list investments' })
  }
})

router.post(
  '/api/v1/broker/investments',
  requireProjectRole('editor'),
  (req: Request, res: Response) => {
    const db = serverDb()
    if (!db) {
      res.status(503).json({ error: 'database unavailable' })
      return
    }

    const body = req.body ?? {}
    const projectId = typeof body.project_id === 'string' ? body.project_id : null
    const assetType = typeof body.asset_type === 'string' ? body.asset_type : ''
    if (!projectId) {
      res.status(400).json({ error: 'project_id required' })
      return
    }
    if (!ALLOWED_ASSET_TYPES.includes(assetType as typeof ALLOWED_ASSET_TYPES[number])) {
      res.status(400).json({ error: `asset_type must be one of ${ALLOWED_ASSET_TYPES.join(', ')}` })
      return
    }

    try {
      const id = `${projectId}--inv-${randomUUID()}`
      const now = Date.now()
      const accountLabel = typeof body.account_label === 'string' ? body.account_label : null
      const symbol = typeof body.symbol === 'string' ? body.symbol : null
      const quantity = body.quantity != null ? Number(body.quantity) : null
      const valueUsd = body.value_usd != null ? Number(body.value_usd) : null
      const asOf = typeof body.as_of === 'string' ? body.as_of : null
      const notes = typeof body.notes === 'string' ? body.notes : null

      if (quantity != null && !Number.isFinite(quantity)) {
        res.status(400).json({ error: 'quantity must be numeric' })
        return
      }
      if (valueUsd != null && !Number.isFinite(valueUsd)) {
        res.status(400).json({ error: 'value_usd must be numeric' })
        return
      }

      db.prepare(`
        INSERT INTO investments (
          id, project_id, asset_type, account_label, symbol, quantity, value_usd,
          as_of, notes, created_at, updated_at
        ) VALUES (
          @id, @project_id, @asset_type, @account_label, @symbol, @quantity, @value_usd,
          @as_of, @notes, @created_at, @updated_at
        )
      `).run({
        id,
        project_id: projectId,
        asset_type: assetType,
        account_label: accountLabel,
        symbol,
        quantity,
        value_usd: valueUsd,
        as_of: asOf,
        notes,
        created_at: now,
        updated_at: now,
      })

      const row = db.prepare('SELECT * FROM investments WHERE id = ?').get(id) as InvestmentRow
      res.status(201).json({ investment: row })
    } catch (err) {
      logger.warn({ err }, 'broker: create investment failed')
      res.status(500).json({ error: 'failed to create investment' })
    }
  },
)

router.put(
  '/api/v1/broker/investments/:id',
  requireProjectRoleForResource('editor', (id) => {
    const db = serverDb()
    if (!db) return null
    const row = db.prepare('SELECT project_id FROM investments WHERE id = ?').get(id) as { project_id: string } | undefined
    return row?.project_id ?? null
  }),
  (req: Request, res: Response) => {
    const db = serverDb()
    if (!db) {
      res.status(503).json({ error: 'database unavailable' })
      return
    }
    const id = String(req.params.id)
    const body = req.body ?? {}

    if (body.asset_type != null && !ALLOWED_ASSET_TYPES.includes(body.asset_type)) {
      res.status(400).json({ error: `asset_type must be one of ${ALLOWED_ASSET_TYPES.join(', ')}` })
      return
    }

    try {
      const existing = db.prepare('SELECT * FROM investments WHERE id = ?').get(id) as InvestmentRow | undefined
      if (!existing) {
        res.status(404).json({ error: 'investment not found' })
        return
      }

      const next = {
        asset_type: body.asset_type !== undefined ? body.asset_type : existing.asset_type,
        account_label: body.account_label !== undefined ? body.account_label : existing.account_label,
        symbol: body.symbol !== undefined ? body.symbol : existing.symbol,
        quantity: body.quantity !== undefined ? (body.quantity == null ? null : Number(body.quantity)) : existing.quantity,
        value_usd: body.value_usd !== undefined ? (body.value_usd == null ? null : Number(body.value_usd)) : existing.value_usd,
        as_of: body.as_of !== undefined ? body.as_of : existing.as_of,
        notes: body.notes !== undefined ? body.notes : existing.notes,
        updated_at: Date.now(),
      }

      if (next.quantity != null && !Number.isFinite(next.quantity)) {
        res.status(400).json({ error: 'quantity must be numeric' })
        return
      }
      if (next.value_usd != null && !Number.isFinite(next.value_usd)) {
        res.status(400).json({ error: 'value_usd must be numeric' })
        return
      }

      db.prepare(`
        UPDATE investments SET
          asset_type = @asset_type, account_label = @account_label,
          symbol = @symbol, quantity = @quantity, value_usd = @value_usd,
          as_of = @as_of, notes = @notes, updated_at = @updated_at
        WHERE id = @id
      `).run({ ...next, id })

      const updated = db.prepare('SELECT * FROM investments WHERE id = ?').get(id) as InvestmentRow
      res.json({ investment: updated })
    } catch (err) {
      logger.warn({ err, id }, 'broker: update investment failed')
      res.status(500).json({ error: 'failed to update investment' })
    }
  },
)

router.delete(
  '/api/v1/broker/investments/:id',
  requireProjectRoleForResource('editor', (id) => {
    const db = serverDb()
    if (!db) return null
    const row = db.prepare('SELECT project_id FROM investments WHERE id = ?').get(id) as { project_id: string } | undefined
    return row?.project_id ?? null
  }),
  (req: Request, res: Response) => {
    const db = serverDb()
    if (!db) {
      res.status(503).json({ error: 'database unavailable' })
      return
    }
    const id = String(req.params.id)
    try {
      const result = db.prepare('DELETE FROM investments WHERE id = ?').run(id)
      if (result.changes === 0) {
        res.status(404).json({ error: 'investment not found' })
        return
      }
      res.json({ deleted: true, id })
    } catch (err) {
      logger.warn({ err, id }, 'broker: delete investment failed')
      res.status(500).json({ error: 'failed to delete investment' })
    }
  },
)

export default router
