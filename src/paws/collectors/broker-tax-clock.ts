// src/paws/collectors/broker-tax-clock.ts
//
// Observe-phase collector for re-tax-deadline-tracker.
//
// Pulls every open tax_event scoped to the broker project, computes
// days_until_due against today (UTC midnight), and tallies past-due,
// 7-day, and 30-day buckets so the ANALYZE LLM can severity-rank cleanly.

import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'

const MS_PER_DAY = 86_400_000

interface TaxEventRow {
  id: string
  event_type: string
  property_id: string | null
  due_date: string | null
  amount: number | null
  hours: number | null
  notes: string | null
}

// Diff a YYYY-MM-DD date string against today (UTC midnight floor).
// Returns null if the input is null or unparseable. Negative = past due.
function daysUntil(dueDate: string | null, nowMs: number): number | null {
  if (!dueDate) return null
  const parsed = Date.parse(`${dueDate}T00:00:00Z`)
  if (Number.isNaN(parsed)) return null
  const todayUtc = Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY
  return Math.floor((parsed - todayUtc) / MS_PER_DAY)
}

export const brokerTaxClockCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()

  let rows: TaxEventRow[] = []
  try {
    const db = getDb()
    // SQLite has no NULLS LAST keyword, so emulate it.
    rows = db.prepare(`
      SELECT id, event_type, property_id, due_date, amount, hours, notes
      FROM tax_events
      WHERE project_id = ?
        AND status = 'open'
      ORDER BY (due_date IS NULL), due_date ASC
    `).all(ctx.projectId) as TaxEventRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`tax_events query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-tax-clock] tax_events query failed')
  }

  const open_events = rows.map((r) => {
    const daysUntilDue = daysUntil(r.due_date, now)
    return {
      id: r.id,
      event_type: r.event_type,
      property_id: r.property_id,
      due_date: r.due_date,
      days_until_due: daysUntilDue,
      amount: r.amount,
      hours: r.hours,
      notes: r.notes,
    }
  })

  let pastDueCount = 0
  let dueWithin7Count = 0
  let dueWithin30Count = 0
  for (const e of open_events) {
    const d = e.days_until_due
    if (d === null) continue
    if (d < 0) pastDueCount += 1
    if (d >= 0 && d <= 7) dueWithin7Count += 1
    if (d >= 0 && d <= 30) dueWithin30Count += 1
  }

  const raw_data = {
    collected_at_ms: now,
    open_events,
    past_due_count: pastDueCount,
    due_within_7_count: dueWithin7Count,
    due_within_30_count: dueWithin30Count,
  }

  logger.info(
    {
      pawId: ctx.pawId,
      totalOpen: open_events.length,
      pastDue: pastDueCount,
      due7: dueWithin7Count,
      due30: dueWithin30Count,
    },
    '[broker-tax-clock] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-tax-clock',
    errors: errors.length ? errors : undefined,
  }
}
