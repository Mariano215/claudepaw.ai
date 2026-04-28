/**
 * broker-routes/participation.ts
 *
 * Two participation routes:
 *   GET  /api/v1/broker/participation/log -- entries + totals
 *   POST /api/v1/broker/participation/log -- editor mutation
 *
 * The log is the IRS-audit-defense ledger for STR loophole + REPS hours.
 * Each entry is evidence: activity must be specific, hours must be plausible,
 * and participant + counted_for must match the entity ownership.
 *
 * GET response shape:
 *   {
 *     entries: ParticipationRow[],
 *     totals: {
 *       reps_total:        number,           // sum of reps + both, all participants
 *       str_per_property:  { [pid]: number } // sum of str + both per property
 *     }
 *   }
 *
 * POST validation:
 *   - participant in ('mariano','father','spouse','contractor','manager','other')
 *   - counted_for in ('str','reps','both','none')
 *   - hours > 0
 *   - activity required (non-empty)
 *
 * 5%-ownership warning: when participant='father' is logged, the response
 * includes a `warning` field reminding the user to verify that the father
 * holds at least 5% of the entity that owns the property. There is no
 * entity_ownership table in v1, so the warning is unconditional for father
 * entries.
 */

import { Router, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger.js'
import { requireProjectRole } from '../auth.js'
import { serverDb } from './shared.js'

const router = Router()

interface ParticipationRow {
  id: string
  project_id: string
  property_id: string | null
  date: string
  activity: string
  hours: number
  evidence_url: string | null
  participant: string
  counted_for: string
  notes: string | null
  created_at: number
}

const ALLOWED_PARTICIPANTS = ['mariano', 'father', 'spouse', 'contractor', 'manager', 'other'] as const
const ALLOWED_COUNTED_FOR = ['str', 'reps', 'both', 'none'] as const

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

router.get('/api/v1/broker/participation/log', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }
  const f = projectFilter(req)
  if (f === null) {
    res.json({
      entries: [],
      totals: { reps_total: 0, str_per_property: {} },
    })
    return
  }

  try {
    const where = f.sql ? `WHERE ${f.sql}` : ''
    const entries = db
      .prepare(`SELECT * FROM participation_log ${where} ORDER BY date DESC, created_at DESC`)
      .all(...f.args) as ParticipationRow[]

    let repsTotal = 0
    const strPerProperty: Record<string, number> = {}
    for (const e of entries) {
      if (e.counted_for === 'reps' || e.counted_for === 'both') {
        repsTotal += e.hours
      }
      if ((e.counted_for === 'str' || e.counted_for === 'both') && e.property_id) {
        strPerProperty[e.property_id] = (strPerProperty[e.property_id] ?? 0) + e.hours
      }
    }

    res.json({
      entries,
      totals: { reps_total: repsTotal, str_per_property: strPerProperty },
    })
  } catch (err) {
    logger.warn({ err }, 'broker: list participation failed')
    res.status(500).json({ error: 'failed to list participation log' })
  }
})

router.post(
  '/api/v1/broker/participation/log',
  requireProjectRole('editor', (req) => {
    // Resolve project_id from body OR property_id row OR fall back to the
    // explicit body.project_id.
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
    const date = typeof body.date === 'string' ? body.date.trim() : ''
    const activity = typeof body.activity === 'string' ? body.activity.trim() : ''
    const hours = Number(body.hours)
    const participant = typeof body.participant === 'string' ? body.participant : ''
    const countedFor = typeof body.counted_for === 'string' ? body.counted_for : ''
    const propertyId = typeof body.property_id === 'string' ? body.property_id : null

    if (!date || !activity) {
      res.status(400).json({ error: 'date and activity are required' })
      return
    }
    if (!Number.isFinite(hours) || hours <= 0) {
      res.status(400).json({ error: 'hours must be a positive number' })
      return
    }
    if (!ALLOWED_PARTICIPANTS.includes(participant as typeof ALLOWED_PARTICIPANTS[number])) {
      res.status(400).json({ error: `participant must be one of ${ALLOWED_PARTICIPANTS.join(', ')}` })
      return
    }
    if (!ALLOWED_COUNTED_FOR.includes(countedFor as typeof ALLOWED_COUNTED_FOR[number])) {
      res.status(400).json({ error: `counted_for must be one of ${ALLOWED_COUNTED_FOR.join(', ')}` })
      return
    }

    try {
      let projectId: string | null = typeof body.project_id === 'string' ? body.project_id : null
      if (propertyId) {
        const prop = db.prepare('SELECT project_id FROM properties WHERE id = ?').get(propertyId) as { project_id: string } | undefined
        if (!prop) {
          res.status(404).json({ error: 'property not found' })
          return
        }
        projectId = prop.project_id
      }
      if (!projectId) {
        res.status(400).json({ error: 'project_id or property_id required' })
        return
      }

      const id = `${projectId}--participation-${randomUUID()}`
      const now = Date.now()
      const evidenceUrl = typeof body.evidence_url === 'string' ? body.evidence_url : null
      const notes = typeof body.notes === 'string' ? body.notes : null

      db.prepare(`
        INSERT INTO participation_log (
          id, project_id, property_id, date, activity, hours, evidence_url,
          participant, counted_for, notes, created_at
        ) VALUES (
          @id, @project_id, @property_id, @date, @activity, @hours, @evidence_url,
          @participant, @counted_for, @notes, @created_at
        )
      `).run({
        id,
        project_id: projectId,
        property_id: propertyId,
        date,
        activity,
        hours,
        evidence_url: evidenceUrl,
        participant,
        counted_for: countedFor,
        notes,
        created_at: now,
      })

      const row = db.prepare('SELECT * FROM participation_log WHERE id = ?').get(id) as ParticipationRow

      const response: { entry: ParticipationRow; warning?: string } = { entry: row }
      if (participant === 'father') {
        response.warning = 'Verify father holds >=5% of entity for hours to count'
      }
      res.status(201).json(response)
    } catch (err) {
      logger.warn({ err }, 'broker: create participation entry failed')
      res.status(500).json({ error: 'failed to create participation entry' })
    }
  },
)

export default router
