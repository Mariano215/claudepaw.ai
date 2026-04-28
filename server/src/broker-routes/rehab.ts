/**
 * broker-routes/rehab.ts
 *
 * Five rehab routes:
 *   GET  /api/v1/broker/rehab-estimates         -- list (project-scoped)
 *   GET  /api/v1/broker/contractors             -- list (project-scoped)
 *   GET  /api/v1/broker/improvements?property_id -- filter by property
 *   POST /api/v1/broker/improvements            -- editor mutation
 *   GET  /api/v1/broker/comps                   -- list (project-scoped)
 *
 * No DELETE/PUT for improvements in v1 -- the table is append-only by
 * design (each row is a receipt for cost-basis defense).
 */

import { Router, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger.js'
import { requireProjectRole } from '../auth.js'
import { serverDb } from './shared.js'

const router = Router()

interface ImprovementRow {
  id: string
  project_id: string
  property_id: string
  description: string
  cost: number
  date: string | null
  photos_url: string | null
  receipts_url: string | null
  created_at: number
}

function projectFilter(req: Request): { sql: string; args: unknown[] } | null {
  const isAdmin = req.user?.isAdmin === true
  const allowed = req.scope?.allowedProjectIds
  const requested = typeof req.query.project_id === 'string' ? req.query.project_id : null

  if (isAdmin) {
    if (requested) return { sql: 'project_id = ?', args: [requested] }
    return { sql: '', args: [] }
  }
  const pids = allowed ?? []
  if (pids.length === 0) return null
  if (requested) {
    if (!pids.includes(requested)) return null
    return { sql: 'project_id = ?', args: [requested] }
  }
  return { sql: `project_id IN (${pids.map(() => '?').join(',')})`, args: [...pids] }
}

router.get('/api/v1/broker/rehab-estimates', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }
  const f = projectFilter(req)
  if (f === null) {
    res.json({ rehab_estimates: [] })
    return
  }

  try {
    const where = f.sql ? `WHERE ${f.sql}` : ''
    const rows = db
      .prepare(`SELECT * FROM rehab_estimates ${where} ORDER BY created_at DESC`)
      .all(...f.args)
    res.json({ rehab_estimates: rows })
  } catch (err) {
    logger.warn({ err }, 'broker: list rehab-estimates failed')
    res.status(500).json({ error: 'failed to list rehab estimates' })
  }
})

router.get('/api/v1/broker/contractors', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }
  const f = projectFilter(req)
  if (f === null) {
    res.json({ contractors: [] })
    return
  }

  try {
    const where = f.sql ? `WHERE ${f.sql}` : ''
    const rows = db
      .prepare(`SELECT * FROM contractors ${where} ORDER BY name`)
      .all(...f.args)
    res.json({ contractors: rows })
  } catch (err) {
    logger.warn({ err }, 'broker: list contractors failed')
    res.status(500).json({ error: 'failed to list contractors' })
  }
})

router.get('/api/v1/broker/improvements', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }
  const f = projectFilter(req)
  if (f === null) {
    res.json({ improvements: [] })
    return
  }

  const propertyId = typeof req.query.property_id === 'string' ? req.query.property_id : null

  try {
    const wheres: string[] = []
    const args: unknown[] = []
    if (f.sql) {
      wheres.push(f.sql)
      args.push(...f.args)
    }
    if (propertyId) {
      wheres.push('property_id = ?')
      args.push(propertyId)
    }
    const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : ''
    const rows = db
      .prepare(`SELECT * FROM improvements ${where} ORDER BY date DESC NULLS LAST, created_at DESC`)
      .all(...args) as ImprovementRow[]
    res.json({ improvements: rows })
  } catch (err) {
    logger.warn({ err }, 'broker: list improvements failed')
    res.status(500).json({ error: 'failed to list improvements' })
  }
})

router.post(
  '/api/v1/broker/improvements',
  requireProjectRole('editor', (req) => {
    // Resolve project_id from body OR from the property_id row.
    const fromBody = typeof req.body?.project_id === 'string' ? req.body.project_id : null
    if (fromBody) return fromBody
    const propertyId = typeof req.body?.property_id === 'string' ? req.body.property_id : null
    if (!propertyId) return null
    const db = serverDb()
    if (!db) return null
    const row = db.prepare('SELECT project_id FROM properties WHERE id = ?').get(propertyId) as { project_id: string } | undefined
    return row?.project_id ?? null
  }),
  (req: Request, res: Response) => {
    const db = serverDb()
    if (!db) {
      res.status(503).json({ error: 'database unavailable' })
      return
    }

    const body = req.body ?? {}
    const propertyId = typeof body.property_id === 'string' ? body.property_id : null
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    const costNum = Number(body.cost)
    if (!propertyId || !description || !Number.isFinite(costNum) || costNum < 0) {
      res.status(400).json({ error: 'property_id, description, and non-negative cost are required' })
      return
    }

    try {
      const property = db
        .prepare('SELECT id, project_id FROM properties WHERE id = ?')
        .get(propertyId) as { id: string; project_id: string } | undefined
      if (!property) {
        res.status(404).json({ error: 'property not found' })
        return
      }

      const id = `${property.project_id}--imp-${randomUUID()}`
      const now = Date.now()
      const date = typeof body.date === 'string' ? body.date : null
      const photosUrl = typeof body.photos_url === 'string' ? body.photos_url : null
      const receiptsUrl = typeof body.receipts_url === 'string' ? body.receipts_url : null

      db.prepare(`
        INSERT INTO improvements (id, project_id, property_id, description, cost, date, photos_url, receipts_url, created_at)
        VALUES (@id, @project_id, @property_id, @description, @cost, @date, @photos_url, @receipts_url, @created_at)
      `).run({
        id,
        project_id: property.project_id,
        property_id: propertyId,
        description,
        cost: costNum,
        date,
        photos_url: photosUrl,
        receipts_url: receiptsUrl,
        created_at: now,
      })

      const row = db.prepare('SELECT * FROM improvements WHERE id = ?').get(id) as ImprovementRow
      res.status(201).json({ improvement: row })
    } catch (err) {
      logger.warn({ err }, 'broker: create improvement failed')
      res.status(500).json({ error: 'failed to create improvement' })
    }
  },
)

router.get('/api/v1/broker/comps', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }
  const f = projectFilter(req)
  if (f === null) {
    res.json({ comps: [] })
    return
  }

  try {
    const where = f.sql ? `WHERE ${f.sql}` : ''
    const rows = db
      .prepare(`SELECT * FROM comps ${where} ORDER BY fetched_at DESC`)
      .all(...f.args)
    res.json({ comps: rows })
  } catch (err) {
    logger.warn({ err }, 'broker: list comps failed')
    res.status(500).json({ error: 'failed to list comps' })
  }
})

export default router
