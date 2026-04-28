// src/paws/collectors/broker-policy-roll.ts
//
// Observe-phase collector for re-insurance-renewal.
//
// Per-property insurance state derived from the expenses table (category =
// 'insurance'). v1 only uses expenses; tax_events does not have an
// insurance event_type in its CHECK constraint. estimated_renewal_date is
// last_insurance_payment + 365 days.

import type { Collector } from './index.js'
import { logger } from '../../logger.js'
import { getDb } from '../../db.js'

const MS_PER_DAY = 86_400_000

interface PropertyInsuranceRow {
  property_id: string
  address: string
  last_insurance_payment: string | null
  last_premium_amount: number | null
  last_carrier: string | null
}

function addDaysToDate(dateStr: string, days: number): string | null {
  const parsed = Date.parse(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(parsed)) return null
  const next = new Date(parsed + days * MS_PER_DAY)
  return next.toISOString().slice(0, 10)
}

function daysUntil(dueDate: string | null, nowMs: number): number | null {
  if (!dueDate) return null
  const parsed = Date.parse(`${dueDate}T00:00:00Z`)
  if (Number.isNaN(parsed)) return null
  const todayUtc = Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY
  return Math.floor((parsed - todayUtc) / MS_PER_DAY)
}

export const brokerPolicyRollCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()

  let rows: PropertyInsuranceRow[] = []
  try {
    const db = getDb()
    // For each property, find the most recent insurance expense.
    // The subquery pins the row with max(occurred_on) per property; the
    // outer LEFT JOIN keeps properties without any insurance expense.
    rows = db.prepare(`
      SELECT
        p.id           AS property_id,
        p.address      AS address,
        e.occurred_on  AS last_insurance_payment,
        e.amount       AS last_premium_amount,
        e.vendor       AS last_carrier
      FROM properties p
      LEFT JOIN expenses e
        ON e.id = (
          SELECT e2.id
          FROM expenses e2
          WHERE e2.project_id = p.project_id
            AND e2.property_id = p.id
            AND e2.category = 'insurance'
          ORDER BY e2.occurred_on DESC
          LIMIT 1
        )
      WHERE p.project_id = ?
      ORDER BY p.address ASC
    `).all(ctx.projectId) as PropertyInsuranceRow[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`policy roll-up query failed: ${msg}`)
    logger.warn({ err, pawId: ctx.pawId }, '[broker-policy-roll] query failed')
  }

  const per_property_policy = rows.map((r) => {
    const estimatedRenewal = r.last_insurance_payment
      ? addDaysToDate(r.last_insurance_payment, 365)
      : null
    return {
      property_id: r.property_id,
      address: r.address,
      last_insurance_payment: r.last_insurance_payment,
      last_premium_amount: r.last_premium_amount,
      last_carrier: r.last_carrier,
      estimated_renewal_date: estimatedRenewal,
      days_until_renewal: daysUntil(estimatedRenewal, now),
      has_any_policy_logged: r.last_insurance_payment !== null,
    }
  })

  const propertiesWithoutPolicy = per_property_policy.filter((p) => !p.has_any_policy_logged).length

  const raw_data = {
    collected_at_ms: now,
    per_property_policy,
    properties_without_policy: propertiesWithoutPolicy,
  }

  logger.info(
    {
      pawId: ctx.pawId,
      propertyCount: per_property_policy.length,
      gaps: propertiesWithoutPolicy,
    },
    '[broker-policy-roll] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-policy-roll',
    errors: errors.length ? errors : undefined,
  }
}
