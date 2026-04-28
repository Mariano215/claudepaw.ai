/**
 * broker-routes/tax.ts
 *
 * Three tax routes:
 *   GET /api/v1/broker/tax-clock        -- aggregated tax-deadline + REPS/STR clock
 *   GET /api/v1/broker/cost-seg-studies -- list of cost-seg studies
 *   GET /api/v1/broker/tax-abatements   -- list of property tax abatements
 *
 * Tax-clock contract (computed live from the underlying tables):
 *   {
 *     reps_hours_ytd:  number,         // sum of participation_log.hours for
 *                                       // counted_for IN ('reps','both') YTD
 *     str_per_property: {              // per-property STR participation hours YTD
 *       [property_id]: { hours: number, address: string }
 *     },
 *     q_estimate:      TaxEvent[],     // event_type='q_estimate' upcoming
 *     "1031_clocks":   TaxEvent[],     // event_type IN ('1031_id_clock','1031_close_clock')
 *     ytd_depreciation: number         // sum cost_seg_studies.year1_deduction
 *                                       // for studies with status='complete'
 *   }
 *
 * Note: the tax_events.event_type CHECK constraint uses '1031_id_clock' /
 * '1031_close_clock' / 'q_estimate' (not '1031_45_day' / '1031_180_day' /
 * 'q_est_due'). This route follows the schema.
 */

import { Router, type Request, type Response } from 'express'
import { logger } from '../logger.js'
import { serverDb } from './shared.js'

const router = Router()

interface ParticipationRow {
  property_id: string | null
  hours: number
  participant: string
  counted_for: string
  date: string
}

interface TaxEventRow {
  id: string
  project_id: string
  event_type: string
  property_id: string | null
  due_date: string | null
  amount: number | null
  hours: number | null
  status: string
  notes: string | null
  created_at: number
}

interface CostSegRow {
  id: string
  project_id: string
  property_id: string
  engagement_date: string | null
  firm: string | null
  study_cost: number | null
  total_basis: number | null
  accelerated_5yr: number | null
  accelerated_15yr: number | null
  sl_27_5yr: number | null
  year1_deduction: number | null
  status: string
  notes: string | null
  created_at: number
}

interface PropertyLite {
  id: string
  project_id: string
  address: string
  use_type: string | null
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

router.get('/api/v1/broker/tax-clock', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }
  const f = projectFilter(req)
  if (f === null) {
    res.json({
      reps_hours_ytd: 0,
      str_per_property: {},
      q_estimate: [],
      '1031_clocks': [],
      ytd_depreciation: 0,
    })
    return
  }

  try {
    const yearStart = `${new Date().getUTCFullYear()}-01-01`
    const where = f.sql ? `${f.sql} AND` : ''

    // REPS hours YTD: any participant whose hours counted_for IN ('reps','both').
    const repsParticipation = db
      .prepare(`
        SELECT property_id, hours, participant, counted_for, date
        FROM participation_log
        WHERE ${where} date >= ?
          AND counted_for IN ('reps','both')
      `)
      .all(...f.args, yearStart) as ParticipationRow[]
    const repsHoursYtd = repsParticipation.reduce((acc, r) => acc + (r.hours ?? 0), 0)

    // STR hours YTD per STR-use property. Filter to participation rows whose
    // counted_for IN ('str','both') AND whose property has use_type='str'.
    const propWhere = f.sql ? `WHERE ${f.sql}` : ''
    const properties = db
      .prepare(`SELECT id, project_id, address, use_type FROM properties ${propWhere}`)
      .all(...f.args) as PropertyLite[]
    const strPropIds = new Set(properties.filter(p => p.use_type === 'str').map(p => p.id))
    const propAddressById = new Map(properties.map(p => [p.id, p.address]))

    const strParticipation = db
      .prepare(`
        SELECT property_id, hours, participant, counted_for, date
        FROM participation_log
        WHERE ${where} date >= ?
          AND counted_for IN ('str','both')
      `)
      .all(...f.args, yearStart) as ParticipationRow[]

    const strPerProperty: Record<string, { hours: number; address: string }> = {}
    for (const row of strParticipation) {
      if (!row.property_id) continue
      if (!strPropIds.has(row.property_id)) continue
      if (!strPerProperty[row.property_id]) {
        strPerProperty[row.property_id] = {
          hours: 0,
          address: propAddressById.get(row.property_id) ?? '',
        }
      }
      strPerProperty[row.property_id].hours += row.hours ?? 0
    }

    // Tax events: q_estimate, 1031_id_clock, 1031_close_clock. Open / future only.
    const taxEvents = db
      .prepare(`
        SELECT id, project_id, event_type, property_id, due_date, amount, hours,
               status, notes, created_at
        FROM tax_events
        WHERE ${where} status IN ('open')
          AND event_type IN ('q_estimate','1031_id_clock','1031_close_clock')
        ORDER BY due_date ASC NULLS LAST
      `)
      .all(...f.args) as TaxEventRow[]
    const qEstimate = taxEvents.filter(t => t.event_type === 'q_estimate')
    const clocks1031 = taxEvents.filter(t => t.event_type === '1031_id_clock' || t.event_type === '1031_close_clock')

    // YTD depreciation: sum year1_deduction across complete studies whose
    // engagement_date falls in the current YTD window (or whose status flipped
    // complete this year). v1 uses status='complete' regardless of date so a
    // study completed mid-year still counts; refine when we have a multi-year
    // deduction schedule.
    const studies = db
      .prepare(`
        SELECT * FROM cost_seg_studies
        WHERE ${where} status = 'complete'
      `)
      .all(...f.args) as CostSegRow[]
    const ytdDepreciation = studies.reduce((acc, s) => acc + (s.year1_deduction ?? 0), 0)

    res.json({
      reps_hours_ytd: repsHoursYtd,
      str_per_property: strPerProperty,
      q_estimate: qEstimate,
      '1031_clocks': clocks1031,
      ytd_depreciation: ytdDepreciation,
    })
  } catch (err) {
    logger.warn({ err }, 'broker: tax-clock failed')
    res.status(500).json({ error: 'failed to compute tax clock' })
  }
})

router.get('/api/v1/broker/cost-seg-studies', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }
  const f = projectFilter(req)
  if (f === null) {
    res.json({ cost_seg_studies: [] })
    return
  }

  try {
    const where = f.sql ? `WHERE ${f.sql}` : ''
    const rows = db
      .prepare(`SELECT * FROM cost_seg_studies ${where} ORDER BY engagement_date DESC NULLS LAST, created_at DESC`)
      .all(...f.args)
    res.json({ cost_seg_studies: rows })
  } catch (err) {
    logger.warn({ err }, 'broker: list cost-seg-studies failed')
    res.status(500).json({ error: 'failed to list cost seg studies' })
  }
})

router.get('/api/v1/broker/tax-abatements', (req: Request, res: Response) => {
  const db = serverDb()
  if (!db) {
    res.status(503).json({ error: 'database unavailable' })
    return
  }
  const f = projectFilter(req)
  if (f === null) {
    res.json({ tax_abatements: [] })
    return
  }

  try {
    const where = f.sql ? `WHERE ${f.sql}` : ''
    const rows = db
      .prepare(`SELECT * FROM tax_abatements ${where} ORDER BY recert_due ASC NULLS LAST, created_at DESC`)
      .all(...f.args)
    res.json({ tax_abatements: rows })
  } catch (err) {
    logger.warn({ err }, 'broker: list tax-abatements failed')
    res.status(500).json({ error: 'failed to list tax abatements' })
  }
})

export default router
