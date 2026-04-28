// src/paws/collectors/broker-listings.ts
//
// Observe-phase collector for re-property-scout.
//
// Pulls active sale listings from Rentcast for the current week's zip
// rotation plus the STR overlay (always on). Uses dist/rentcast-cli.js
// because it owns the cache + monthly budget gate; we re-shell into it
// per-zip and aggregate the results.
//
// Zip rotation source: projects/broker/context.md "Tiered Market Strategy".
// Quarter index = ((week_of_month - 1) // 7) % 4. Week-of-month = day-of-month.
//   Q0: STR overlay only
//   Q1: STR overlay + Tier 1 hunt
//   Q2: STR overlay + Tier 2 scale
//   Q3: STR overlay + Tier 3 hold
//
// Web supplement (Bash search) is intentionally NOT done here. The act/report
// phase prompts cover that. This collector returns Rentcast data only.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { Collector } from './index.js'
import { logger } from '../../logger.js'

const execFileP = promisify(execFile)

const NODE_BIN = '/opt/homebrew/bin/node'
const RENTCAST_CLI = path.resolve(process.cwd(), 'dist/rentcast-cli.js')
const MAX_BUFFER_BYTES = 4 * 1024 * 1024 // 4MB stdout cap

// ---------------------------------------------------------------------------
// Zip lists -- mirror projects/broker/context.md exactly. Update both when
// the tier strategy changes.
// ---------------------------------------------------------------------------

const STR_OVERLAY_ZIPS = [
  // Philly STR-zoned (Center City + NoLibs + Fishtown + Old City + Rittenhouse)
  '19103', '19106', '19107', '19123', '19125',
  // Beach: Cape May / Wildwood / Avalon / Sea Isle / OCNJ / Rehoboth / Lewes
  '08204', '08260', '08202', '08243', '08226', '19971', '19958',
  // Pocono / lake
  '18301', '18360',
]

const TIER_1_ZIPS = [
  // Philly
  '19142', '19143', '19139', '19140', '19132', '19134', '19124', '19120', '19138', '19141',
  // Delco
  '19013', '19033', '19023', '19036', '19050', '19082',
  // Camden NJ
  '08104', '08105',
  // Wilmington DE
  '19801', '19802', '19805',
]

const TIER_2_ZIPS = [
  // Delco
  '19026', '19064', '19081', '19094', '19078', '19070',
  // Bucks/Mont
  '19006', '19044', '19075', '19046', '19090', '19020',
  // NE Philly
  '19111', '19136', '19149', '19152',
]

const TIER_3_ZIPS = [
  // Mont Co
  '19010', '19087', '19035', '19460',
  // Bucks
  '18901', '18940', '19067',
  // S Jersey
  '08003', '08033',
]

const STR_OVERLAY_SET = new Set(STR_OVERLAY_ZIPS)
const TIER_1_SET = new Set(TIER_1_ZIPS)
const TIER_2_SET = new Set(TIER_2_ZIPS)
const TIER_3_SET = new Set(TIER_3_ZIPS)

type Tier = 'str' | 'tier1' | 'tier2' | 'tier3' | 'unknown'

function tierFor(zip: string): Tier {
  if (STR_OVERLAY_SET.has(zip)) return 'str'
  if (TIER_1_SET.has(zip)) return 'tier1'
  if (TIER_2_SET.has(zip)) return 'tier2'
  if (TIER_3_SET.has(zip)) return 'tier3'
  return 'unknown'
}

// Pre-extracted fixer/distress signals. Order matters for readability only;
// matches are case-insensitive.
const FIXER_PATTERNS: Array<{ tag: string; re: RegExp }> = [
  { tag: 'as-is', re: /\bas[\s-]?is\b/i },
  { tag: 'estate', re: /\bestate( sale)?\b/i },
  { tag: 'tlc', re: /\btlc\b/i },
  { tag: 'investor', re: /\binvestor[s']?\b/i },
  { tag: 'cash only', re: /\bcash[\s-]?only\b/i },
  { tag: 'vacant', re: /\bvacant\b/i },
  { tag: 'fixer', re: /\bfixer([\s-]?upper)?\b/i },
  { tag: 'handyman', re: /\bhandyman( special)?\b/i },
  { tag: 'needs work', re: /\bneeds (work|updating|tlc)\b/i },
  { tag: 'motivated', re: /\bmotivated( seller)?\b/i },
  { tag: 'distressed', re: /\bdistressed\b/i },
  { tag: 'reo', re: /\b(reo|bank[\s-]?owned|foreclosure)\b/i },
  { tag: 'short sale', re: /\bshort[\s-]?sale\b/i },
  { tag: 'probate', re: /\bprobate\b/i },
]

function extractFixerSignals(remarks: string | null | undefined): string[] {
  if (!remarks) return []
  const tags: string[] = []
  for (const { tag, re } of FIXER_PATTERNS) {
    if (re.test(remarks)) tags.push(tag)
  }
  return tags
}

function slugifyAddress(address: string, zip: string): string {
  const slug = address.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${slug}-${zip}`
}

// ---------------------------------------------------------------------------
// Rotation maths -- week_of_month = day-of-month, quarter = ((wom-1)//7) % 4.
// Day 1-7 -> Q0, 8-14 -> Q1, 15-21 -> Q2, 22-28 -> Q3, 29-31 -> Q0 (rolls).
// ---------------------------------------------------------------------------

interface Rotation {
  week_of_month: number
  quarter: 0 | 1 | 2 | 3
  active_zips: string[]
}

function computeRotation(now: Date = new Date()): Rotation {
  const dom = now.getDate()
  const week = dom
  const quarter = (Math.floor((dom - 1) / 7) % 4) as 0 | 1 | 2 | 3
  let tierZips: string[] = []
  if (quarter === 1) tierZips = TIER_1_ZIPS
  else if (quarter === 2) tierZips = TIER_2_ZIPS
  else if (quarter === 3) tierZips = TIER_3_ZIPS
  // Q0: overlay only.
  const active = Array.from(new Set([...STR_OVERLAY_ZIPS, ...tierZips]))
  return { week_of_month: week, quarter, active_zips: active }
}

// ---------------------------------------------------------------------------
// Rentcast CLI invocation
// ---------------------------------------------------------------------------

interface RentcastWrapped {
  ok: boolean
  from_cache: boolean
  budget_exhausted: boolean
  calls_this_month: number
  cap: number
  data: unknown
}

interface RawListing {
  id?: string
  formattedAddress?: string
  addressLine1?: string
  address?: string
  zipCode?: string
  price?: number
  bedrooms?: number
  bathrooms?: number
  squareFootage?: number
  daysOnMarket?: number
  propertyType?: string
  latitude?: number
  longitude?: number
  listingRemarks?: string
  description?: string
}

async function pullZip(
  zip: string,
  maxPrice: number,
): Promise<{ wrapped: RentcastWrapped | null; error?: string }> {
  try {
    const { stdout } = await execFileP(
      NODE_BIN,
      [RENTCAST_CLI, 'listings', '--zip', zip, '--max-price', String(maxPrice)],
      { maxBuffer: MAX_BUFFER_BYTES, timeout: 30_000 },
    )
    const line = stdout.trim().split('\n').pop() ?? ''
    if (!line) {
      return { wrapped: null, error: `zip ${zip}: empty stdout from rentcast-cli` }
    }
    try {
      const parsed = JSON.parse(line) as RentcastWrapped
      return { wrapped: parsed }
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr)
      return { wrapped: null, error: `zip ${zip}: JSON parse failed: ${msg}` }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    if (e.code === 'ENOENT') {
      return {
        wrapped: null,
        error: `rentcast-cli not present at ${RENTCAST_CLI} (run npm run build)`,
      }
    }
    const stderr = e.stderr ? `: ${String(e.stderr).slice(0, 300)}` : ''
    const msg = e.message ?? String(err)
    return { wrapped: null, error: `zip ${zip}: rentcast-cli failed: ${msg}${stderr}` }
  }
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export const brokerListingsCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()
  const maxPrice = typeof ctx.args?.max_price === 'number' ? ctx.args.max_price : 350_000

  const rotation = computeRotation(new Date(now))

  let budgetExhausted = false
  let callsUsed: number | null = null
  let cap: number | null = null
  let cliMissing = false

  type OutListing = {
    id: string
    address: string
    zip: string
    price: number
    beds: number | null
    baths: number | null
    sqft: number | null
    days_on_market: number | null
    property_type: string | null
    latitude: number | null
    longitude: number | null
    listing_remarks: string | null
    source: 'rentcast'
    fixer_signals: string[]
    is_str_overlay: boolean
    tier: Tier
  }

  const listings: OutListing[] = []

  for (const zip of rotation.active_zips) {
    if (cliMissing) break // no point trying more zips if the binary is missing
    const { wrapped, error } = await pullZip(zip, maxPrice)
    if (error) {
      if (error.includes('not present')) cliMissing = true
      errors.push(error)
      continue
    }
    if (!wrapped) {
      errors.push(`zip ${zip}: no wrapped response`)
      continue
    }

    if (typeof wrapped.calls_this_month === 'number') callsUsed = wrapped.calls_this_month
    if (typeof wrapped.cap === 'number') cap = wrapped.cap
    if (wrapped.budget_exhausted) {
      budgetExhausted = true
      // CLI returned a stub when budget exhausted; data is metadata only.
      continue
    }

    const data = Array.isArray(wrapped.data) ? wrapped.data : []
    for (const raw of data as RawListing[]) {
      const address = raw.formattedAddress ?? raw.addressLine1 ?? raw.address ?? ''
      const zipCode = raw.zipCode ?? zip
      const price = typeof raw.price === 'number' ? raw.price : null
      if (!address || price === null) continue // skip rows we can't anchor

      const remarks = raw.listingRemarks ?? raw.description ?? null
      listings.push({
        id: raw.id ?? slugifyAddress(address, zipCode),
        address,
        zip: zipCode,
        price,
        beds: typeof raw.bedrooms === 'number' ? raw.bedrooms : null,
        baths: typeof raw.bathrooms === 'number' ? raw.bathrooms : null,
        sqft: typeof raw.squareFootage === 'number' ? raw.squareFootage : null,
        days_on_market: typeof raw.daysOnMarket === 'number' ? raw.daysOnMarket : null,
        property_type: raw.propertyType ?? null,
        latitude: typeof raw.latitude === 'number' ? raw.latitude : null,
        longitude: typeof raw.longitude === 'number' ? raw.longitude : null,
        listing_remarks: remarks,
        source: 'rentcast',
        fixer_signals: extractFixerSignals(remarks),
        is_str_overlay: STR_OVERLAY_SET.has(zipCode),
        tier: tierFor(zipCode),
      })
    }
  }

  const raw_data = {
    collected_at_ms: now,
    week_of_month: rotation.week_of_month,
    quarter: rotation.quarter,
    active_zips: rotation.active_zips,
    budget_exhausted: budgetExhausted,
    rentcast_calls_used_this_month: callsUsed,
    rentcast_cap: cap,
    listings,
    total_listings: listings.length,
  }

  logger.info(
    {
      pawId: ctx.pawId,
      quarter: rotation.quarter,
      activeZips: rotation.active_zips.length,
      totalListings: listings.length,
      budgetExhausted,
      cliMissing,
    },
    '[broker-listings] collect complete',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-listings',
    errors: errors.length ? errors : undefined,
  }
}
