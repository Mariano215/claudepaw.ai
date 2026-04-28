// src/paws/collectors/broker-str-pricing.ts
//
// Observe-phase collector for re-str-pricing-watch.
//
// Per-owned-STR snapshot: current ADR / 30d occupancy from str_bookings,
// median ADR / occupancy from str_comps tagged for the same subject_address.
//
// v1 simplification:
//   - current_adr  = avg of (gross_rev / nights) across COMPLETED bookings
//                    in the last 30 days. Skips inquiries / cancelled.
//   - current_occupancy_30d = sum(nights overlapping the last 30 days) / 30.
//     Caps at 1.0 in case bookings overlap (defensive).
//   - comp_median_adr / comp_median_occupancy_30d = median across str_comps
//     rows whose subject_address == property.address.
//
// Missing data is honest: null fields + an entry pushed to errors[]. The
// downstream paw can still cycle and the agent will know which property
// lacks the upstream signal.

import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'

const MS_PER_DAY = 86_400_000
const UNDERPRICED_FLAG_THRESHOLD = 0.10 // 10%

interface PropertyRow {
  id: string
  address: string
  str_listing_url: string | null
}

interface BookingRow {
  gross_rev: number | null
  nights: number | null
  check_in: string | null
  check_out: string | null
}

interface CompRow {
  adr: number | null
  occupancy_pct: number | null
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

// Days of overlap between [startMs, endMs) and the trailing 30-day window
// ending at nowMs. nights are summed via overlap, not booking nights total.
function overlapDays(checkIn: string | null, checkOut: string | null, nowMs: number): number {
  if (!checkIn || !checkOut) return 0
  const ci = Date.parse(`${checkIn}T00:00:00Z`)
  const co = Date.parse(`${checkOut}T00:00:00Z`)
  if (Number.isNaN(ci) || Number.isNaN(co) || co <= ci) return 0
  const windowStart = nowMs - 30 * MS_PER_DAY
  const overlapStart = Math.max(ci, windowStart)
  const overlapEnd = Math.min(co, nowMs)
  if (overlapEnd <= overlapStart) return 0
  return (overlapEnd - overlapStart) / MS_PER_DAY
}

export const brokerStrPricingCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()
  const since = now - 30 * MS_PER_DAY
  const sinceDate = new Date(since).toISOString().slice(0, 10)

  let properties: PropertyRow[] = []
  try {
    const db = getDb()
    properties = db.prepare(`
      SELECT id, address, str_listing_url
      FROM properties
      WHERE project_id = ?
        AND status = 'active'
        AND use_type = 'str'
        AND str_listing_url IS NOT NULL
        AND str_listing_url <> ''
      ORDER BY address ASC
    `).all(ctx.projectId) as PropertyRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`properties query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-str-pricing] properties query failed')
  }

  const out: Array<{
    property_id: string
    address: string
    str_listing_url: string | null
    current_adr: number | null
    current_occupancy_30d: number | null
    comp_median_adr: number | null
    comp_median_occupancy_30d: number | null
    comp_count: number
    underpriced_pct: number | null
    underpriced_flag: boolean
  }> = []

  for (const p of properties) {
    let currentAdr: number | null = null
    let currentOccupancy: number | null = null
    let compMedianAdr: number | null = null
    let compMedianOccupancy: number | null = null
    let compCount = 0

    // ----- current ADR + occupancy from str_bookings ---------------------
    try {
      const db = getDb()
      const bookings = db.prepare(`
        SELECT gross_rev, nights, check_in, check_out
        FROM str_bookings
        WHERE project_id = ?
          AND property_id = ?
          AND status = 'completed'
          AND check_out >= ?
      `).all(ctx.projectId, p.id, sinceDate) as BookingRow[]

      const adrSamples: number[] = []
      let occupiedDays = 0
      for (const b of bookings) {
        if (b.gross_rev !== null && b.nights !== null && b.nights > 0) {
          adrSamples.push(b.gross_rev / b.nights)
        }
        occupiedDays += overlapDays(b.check_in, b.check_out, now)
      }
      if (adrSamples.length > 0) {
        currentAdr = adrSamples.reduce((a, b) => a + b, 0) / adrSamples.length
      } else {
        errors.push(`${p.id}: no completed str_bookings in last 30 days`)
      }
      // Cap occupancy at 1.0 in case overlapping bookings inflate it.
      currentOccupancy = Math.min(occupiedDays / 30, 1.0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`bookings query failed for ${p.id}: ${msg}`)
      logger.warn({ err, pawId: ctx.pawId, propertyId: p.id }, '[broker-str-pricing] bookings query failed')
    }

    // ----- comp medians from str_comps -----------------------------------
    try {
      const db = getDb()
      const comps = db.prepare(`
        SELECT adr, occupancy_pct
        FROM str_comps
        WHERE project_id = ?
          AND subject_address = ?
      `).all(ctx.projectId, p.address) as CompRow[]
      compCount = comps.length

      const adrs = comps.map((c) => c.adr).filter((v): v is number => typeof v === 'number')
      const occs = comps
        .map((c) => c.occupancy_pct)
        .filter((v): v is number => typeof v === 'number')
      compMedianAdr = median(adrs)
      const medianOccPct = median(occs)
      // str_comps.occupancy_pct stored as percent (0-100) by convention.
      // Normalize to 0-1 for parity with current_occupancy_30d.
      compMedianOccupancy = medianOccPct === null ? null : medianOccPct / 100
      if (compCount === 0) {
        errors.push(`${p.id}: no str_comps logged for ${p.address}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`str_comps query failed for ${p.id}: ${msg}`)
      logger.warn({ err, pawId: ctx.pawId, propertyId: p.id }, '[broker-str-pricing] str_comps query failed')
    }

    let underpricedPct: number | null = null
    if (currentAdr !== null && compMedianAdr !== null && compMedianAdr > 0) {
      underpricedPct = (compMedianAdr - currentAdr) / compMedianAdr
    }
    const underpricedFlag = underpricedPct !== null && underpricedPct >= UNDERPRICED_FLAG_THRESHOLD

    out.push({
      property_id: p.id,
      address: p.address,
      str_listing_url: p.str_listing_url,
      current_adr: currentAdr,
      current_occupancy_30d: currentOccupancy,
      comp_median_adr: compMedianAdr,
      comp_median_occupancy_30d: compMedianOccupancy,
      comp_count: compCount,
      underpriced_pct: underpricedPct,
      underpriced_flag: underpricedFlag,
    })
  }

  const raw_data = {
    collected_at_ms: now,
    properties: out,
  }

  logger.info(
    {
      pawId: ctx.pawId,
      propertyCount: out.length,
      underpricedCount: out.filter((p) => p.underpriced_flag).length,
    },
    '[broker-str-pricing] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-str-pricing',
    errors: errors.length ? errors : undefined,
  }
}
