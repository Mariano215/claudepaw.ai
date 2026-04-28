// src/paws/collectors/broker-str-bookings-snapshot.ts
//
// Observe-phase collector for re-str-cleaning-turnover.
//
// Returns confirmed/in_stay STR bookings checking out in the next 48 hours
// with a pre-computed boolean has_cleaning_scheduled (true when an
// expenses row exists for the property with category='cleaning' and
// occurred_on between check_out and check_out + 1 day).

import type Database from 'better-sqlite3'
import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'

const MS_PER_HOUR = 3_600_000
const MS_PER_DAY = 86_400_000

interface BookingRow {
  booking_id: string
  property_id: string
  address: string
  check_out: string
}

interface CleaningRow {
  id: string
}

function hoursUntil(dateStr: string, nowMs: number): number {
  const parsed = Date.parse(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(parsed)) return 0
  return Math.floor((parsed - nowMs) / MS_PER_HOUR)
}

function addDaysToDate(dateStr: string, days: number): string | null {
  const parsed = Date.parse(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(parsed)) return null
  return new Date(parsed + days * MS_PER_DAY).toISOString().slice(0, 10)
}

export const brokerStrBookingsSnapshotCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()

  let bookings: BookingRow[] = []
  try {
    const db = getDb()
    bookings = db.prepare(`
      SELECT
        b.id          AS booking_id,
        b.property_id AS property_id,
        p.address     AS address,
        b.check_out   AS check_out
      FROM str_bookings b
      JOIN properties p ON p.id = b.property_id
      WHERE b.project_id = ?
        AND b.check_out >= date('now')
        AND b.check_out <= date('now', '+2 days')
        AND b.status IN ('confirmed','in_stay')
      ORDER BY b.check_out ASC
    `).all(ctx.projectId) as BookingRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`str_bookings query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-str-bookings-snapshot] bookings query failed')
  }

  const upcoming_checkouts: Array<{
    booking_id: string
    property_id: string
    address: string
    check_out: string
    hours_until_checkout: number
    has_cleaning_scheduled: boolean
    cleaning_expense_id: string | null
  }> = []

  let cleaningStmt: Database.Statement | null = null
  try {
    cleaningStmt = getDb().prepare(`
      SELECT id
      FROM expenses
      WHERE project_id = ?
        AND property_id = ?
        AND category = 'cleaning'
        AND occurred_on >= ?
        AND occurred_on <= ?
      LIMIT 1
    `)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`cleaning prepare failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-str-bookings-snapshot] cleaning prepare failed')
  }

  for (const b of bookings) {
    let cleaningRow: CleaningRow | undefined
    if (cleaningStmt) {
      try {
        const windowEnd = addDaysToDate(b.check_out, 1) ?? b.check_out
        cleaningRow = cleaningStmt.get(ctx.projectId, b.property_id, b.check_out, windowEnd) as
          | CleaningRow
          | undefined
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`cleaning lookup failed for booking ${b.booking_id}: ${msg}`)
        logger.warn(
          { err, pawId: ctx.pawId, bookingId: b.booking_id },
          '[broker-str-bookings-snapshot] cleaning lookup failed',
        )
      }
    }

    upcoming_checkouts.push({
      booking_id: b.booking_id,
      property_id: b.property_id,
      address: b.address,
      check_out: b.check_out,
      hours_until_checkout: hoursUntil(b.check_out, now),
      has_cleaning_scheduled: Boolean(cleaningRow),
      cleaning_expense_id: cleaningRow?.id ?? null,
    })
  }

  const raw_data = {
    collected_at_ms: now,
    upcoming_checkouts,
  }

  logger.info(
    {
      pawId: ctx.pawId,
      upcomingCount: upcoming_checkouts.length,
      withCleaning: upcoming_checkouts.filter((c) => c.has_cleaning_scheduled).length,
    },
    '[broker-str-bookings-snapshot] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-str-bookings-snapshot',
    errors: errors.length ? errors : undefined,
  }
}
