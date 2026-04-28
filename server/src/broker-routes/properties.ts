/**
 * broker-routes/properties.ts
 *
 * Three property routes:
 *   GET /api/v1/broker/properties           -- list (project-scoped)
 *   GET /api/v1/broker/properties/:id       -- single
 *   PUT /api/v1/broker/properties/:id       -- editor mutation
 *
 * The list endpoint applies the three-state convention from
 * resolveProjectScope: admin gets the full table, scoped members get
 * AND project_id IN (?, ?, ...), no-access returns []. Single + put
 * return 404 when the row is not visible to the caller.
 */

import { Router, type Request, type Response } from 'express'
import { logger } from '../logger.js'
import { requireProjectRoleForResource } from '../routes.js'
import { serverDb, getProjectId } from './shared.js'

const router = Router()

interface PropertyRow {
  id: string
  project_id: string
  address: string
  zip: string | null
  county: string | null
  lat: number | null
  lng: number | null
  beds: number | null
  baths: number | null
  sqft: number | null
  year_built: number | null
  property_type: string | null
  use_type: string | null
  acquisition_date: string | null
  acquisition_price: number | null
  cost_basis: number | null
  current_arv: number | null
  brrrr_phase: string | null
  str_listing_url: string | null
  status: string
  created_at: number
  updated_at: number
}

const ALLOWED_USE_TYPES = ['str', 'ltr', 'primary', 'flip', 'vacant'] as const
const ALLOWED_BRRRR_PHASES = ['buy', 'rehab', 'rent', 'refi', 'recycle', 'exit'] as const
const ALLOWED_STATUSES = ['active', 'sold', 'under_contract', 'passed', 'archived'] as const

router.get('/api/v1/broker/properties', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }

  try {
    const isAdmin = req.user?.isAdmin === true
    const allowed = req.scope?.allowedProjectIds
    const requested = typeof req.query.project_id === 'string' ? req.query.project_id : null

    let rows: PropertyRow[] = []
    if (isAdmin) {
      if (requested) {
        rows = db
          .prepare('SELECT * FROM properties WHERE project_id = ? ORDER BY created_at DESC')
          .all(requested) as PropertyRow[]
      } else {
        rows = db
          .prepare('SELECT * FROM properties ORDER BY created_at DESC')
          .all() as PropertyRow[]
      }
    } else {
      const pids = allowed ?? []
      if (pids.length === 0) {
        res.json({ properties: [] })
        return
      }
      const placeholders = pids.map(() => '?').join(',')
      rows = db
        .prepare(`SELECT * FROM properties WHERE project_id IN (${placeholders}) ORDER BY created_at DESC`)
        .all(...pids) as PropertyRow[]
    }
    res.json({ properties: rows })
  } catch (err) {
    logger.warn({ err }, 'broker: list properties failed')
    res.status(500).json({ error: 'failed to list properties' })
  }
})

router.get('/api/v1/broker/properties/:id', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }
  const id = String(req.params.id)
  try {
    const row = db.prepare('SELECT * FROM properties WHERE id = ?').get(id) as PropertyRow | undefined
    if (!row) {
      res.status(404).json({ error: 'property not found' })
      return
    }
    if (!req.user?.isAdmin) {
      const allowed = req.scope?.allowedProjectIds ?? []
      if (!allowed.includes(row.project_id)) {
        res.status(404).json({ error: 'property not found' })
        return
      }
    }
    res.json({ property: row })
  } catch (err) {
    logger.warn({ err, id }, 'broker: get property failed')
    res.status(500).json({ error: 'failed to read property' })
  }
})

router.put(
  '/api/v1/broker/properties/:id',
  requireProjectRoleForResource('editor', (id) => {
    const db = serverDb()
    if (!db) return null
    const row = db.prepare('SELECT project_id FROM properties WHERE id = ?').get(id) as { project_id: string } | undefined
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

    // Validate enums when provided.
    if (body.use_type != null && !ALLOWED_USE_TYPES.includes(body.use_type)) {
      res.status(400).json({ error: `use_type must be one of ${ALLOWED_USE_TYPES.join(', ')}` })
      return
    }
    if (body.brrrr_phase != null && !ALLOWED_BRRRR_PHASES.includes(body.brrrr_phase)) {
      res.status(400).json({ error: `brrrr_phase must be one of ${ALLOWED_BRRRR_PHASES.join(', ')}` })
      return
    }
    if (body.status != null && !ALLOWED_STATUSES.includes(body.status)) {
      res.status(400).json({ error: `status must be one of ${ALLOWED_STATUSES.join(', ')}` })
      return
    }

    try {
      const existing = db.prepare('SELECT * FROM properties WHERE id = ?').get(id) as PropertyRow | undefined
      if (!existing) {
        res.status(404).json({ error: 'property not found' })
        return
      }

      const next = {
        address: typeof body.address === 'string' ? body.address : existing.address,
        zip: body.zip !== undefined ? body.zip : existing.zip,
        county: body.county !== undefined ? body.county : existing.county,
        lat: body.lat !== undefined ? body.lat : existing.lat,
        lng: body.lng !== undefined ? body.lng : existing.lng,
        beds: body.beds !== undefined ? body.beds : existing.beds,
        baths: body.baths !== undefined ? body.baths : existing.baths,
        sqft: body.sqft !== undefined ? body.sqft : existing.sqft,
        year_built: body.year_built !== undefined ? body.year_built : existing.year_built,
        property_type: body.property_type !== undefined ? body.property_type : existing.property_type,
        use_type: body.use_type !== undefined ? body.use_type : existing.use_type,
        acquisition_date: body.acquisition_date !== undefined ? body.acquisition_date : existing.acquisition_date,
        acquisition_price: body.acquisition_price !== undefined ? body.acquisition_price : existing.acquisition_price,
        cost_basis: body.cost_basis !== undefined ? body.cost_basis : existing.cost_basis,
        current_arv: body.current_arv !== undefined ? body.current_arv : existing.current_arv,
        brrrr_phase: body.brrrr_phase !== undefined ? body.brrrr_phase : existing.brrrr_phase,
        str_listing_url: body.str_listing_url !== undefined ? body.str_listing_url : existing.str_listing_url,
        status: body.status !== undefined ? body.status : existing.status,
        updated_at: Date.now(),
      }

      db.prepare(`
        UPDATE properties SET
          address = @address, zip = @zip, county = @county,
          lat = @lat, lng = @lng, beds = @beds, baths = @baths,
          sqft = @sqft, year_built = @year_built, property_type = @property_type,
          use_type = @use_type, acquisition_date = @acquisition_date,
          acquisition_price = @acquisition_price, cost_basis = @cost_basis,
          current_arv = @current_arv, brrrr_phase = @brrrr_phase,
          str_listing_url = @str_listing_url, status = @status, updated_at = @updated_at
        WHERE id = @id
      `).run({ ...next, id })

      const updated = db.prepare('SELECT * FROM properties WHERE id = ?').get(id) as PropertyRow
      res.json({ property: updated })
    } catch (err) {
      logger.warn({ err, id }, 'broker: update property failed')
      res.status(500).json({ error: 'failed to update property' })
    }
  },
)

// Silence unused-import warning when the helper is referenced only via
// requireProjectRoleForResource closures.
void getProjectId

export default router
