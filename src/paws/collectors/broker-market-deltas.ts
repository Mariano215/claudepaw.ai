// src/paws/collectors/broker-market-deltas.ts
//
// Observe-phase collector for re-market-shift-watcher.
//
// Per-zip month-over-month price/rent deltas across the full broker
// universe (STR overlay + Tier 1 + Tier 2 + Tier 3). Because this paw fires
// weekly, all four quarters are included so the watcher always sees the
// whole map -- not just the active rotation week.
//
// v1 stub on MoM diff:
//   The rentcast_cache only keeps the LATEST response per (endpoint, query)
//   key (ON CONFLICT DO UPDATE). There is no historical snapshot store yet,
//   so we cannot compute "1 month ago" without standing up a separate
//   markets_history table + nightly snapshot job.
//
//   What this v1 does: pull current values via dist/rentcast-cli.js markets
//   (cache-friendly, zero-cost on warm cache), return them with
//   median_price_1mo_ago / median_rent_1mo_ago / *_pct_change as null and
//   has_prior_observation=false. The agent reports "first observation;
//   delta tracking begins next cycle" cleanly.
//
//   Follow-up (v2): add a markets_history table (zip, observed_at, sale_*,
//   rental_*) populated nightly, and read prior month from there.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { Collector } from './index.js'
import { logger } from '../../logger.js'

const execFileP = promisify(execFile)

const NODE_BIN = '/opt/homebrew/bin/node'
const RENTCAST_CLI = path.resolve(process.cwd(), 'dist/rentcast-cli.js')
const MAX_BUFFER_BYTES = 4 * 1024 * 1024

// Universe -- mirror src/paws/collectors/broker-listings.ts. Keep in sync.
const STR_OVERLAY_ZIPS = [
  '19103', '19106', '19107', '19123', '19125',
  '08204', '08260', '08202', '08243', '08226', '19971', '19958',
  '18301', '18360',
]
const TIER_1_ZIPS = [
  '19142', '19143', '19139', '19140', '19132', '19134', '19124', '19120', '19138', '19141',
  '19013', '19033', '19023', '19036', '19050', '19082',
  '08104', '08105',
  '19801', '19802', '19805',
]
const TIER_2_ZIPS = [
  '19026', '19064', '19081', '19094', '19078', '19070',
  '19006', '19044', '19075', '19046', '19090', '19020',
  '19111', '19136', '19149', '19152',
]
const TIER_3_ZIPS = [
  '19010', '19087', '19035', '19460',
  '18901', '18940', '19067',
  '08003', '08033',
]

type Tier = 'str' | 'tier1' | 'tier2' | 'tier3'

const ZIP_TIER_MAP: Map<string, Tier> = new Map()
for (const z of STR_OVERLAY_ZIPS) ZIP_TIER_MAP.set(z, 'str')
for (const z of TIER_1_ZIPS) if (!ZIP_TIER_MAP.has(z)) ZIP_TIER_MAP.set(z, 'tier1')
for (const z of TIER_2_ZIPS) if (!ZIP_TIER_MAP.has(z)) ZIP_TIER_MAP.set(z, 'tier2')
for (const z of TIER_3_ZIPS) if (!ZIP_TIER_MAP.has(z)) ZIP_TIER_MAP.set(z, 'tier3')

const ALL_ZIPS = Array.from(ZIP_TIER_MAP.keys())

interface RentcastWrapped {
  ok: boolean
  from_cache: boolean
  budget_exhausted: boolean
  calls_this_month: number
  cap: number
  data: unknown
}

interface MarketsPayload {
  saleData?: {
    medianPrice?: number
    totalListings?: number
  }
  rentalData?: {
    medianRent?: number
    totalListings?: number
  }
}

async function pullMarkets(
  zip: string,
): Promise<{ wrapped: RentcastWrapped | null; error?: string; cliMissing?: boolean }> {
  try {
    const { stdout } = await execFileP(
      NODE_BIN,
      [RENTCAST_CLI, 'markets', '--zip', zip],
      { maxBuffer: MAX_BUFFER_BYTES, timeout: 30_000 },
    )
    const line = stdout.trim().split('\n').pop() ?? ''
    if (!line) return { wrapped: null, error: `zip ${zip}: empty stdout from rentcast-cli markets` }
    try {
      return { wrapped: JSON.parse(line) as RentcastWrapped }
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr)
      return { wrapped: null, error: `zip ${zip}: markets JSON parse failed: ${msg}` }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    if (e.code === 'ENOENT') {
      return {
        wrapped: null,
        error: `rentcast-cli not present at ${RENTCAST_CLI}`,
        cliMissing: true,
      }
    }
    const stderr = e.stderr ? `: ${String(e.stderr).slice(0, 300)}` : ''
    const msg = e.message ?? String(err)
    return { wrapped: null, error: `zip ${zip}: markets cli failed: ${msg}${stderr}` }
  }
}

export const brokerMarketDeltasCollector: Collector = async (ctx) => {
  const errors: string[] = []
  const now = Date.now()

  let budgetExhausted = false
  let cliMissing = false

  // v1 stub note -- surfaces in errors[] so the agent can report it cleanly.
  errors.push(
    'v1 stub: month-over-month delta tracking not yet wired (no markets_history snapshot store). ' +
    'Returning current values with has_prior_observation=false. Add markets_history table + nightly snapshot in v2.',
  )

  type ZipOut = {
    zip: string
    median_price_now: number | null
    median_price_1mo_ago: number | null
    price_pct_change: number | null
    median_rent_now: number | null
    median_rent_1mo_ago: number | null
    rent_pct_change: number | null
    sample_size: number | null
    tier: Tier
    has_prior_observation: boolean
  }

  const out: ZipOut[] = []

  for (const zip of ALL_ZIPS) {
    const tier = ZIP_TIER_MAP.get(zip)!
    if (cliMissing) {
      // bail out fast once we know the CLI is missing -- still emit zip rows
      // with all-null fields so the watcher sees the universe.
      out.push({
        zip,
        median_price_now: null,
        median_price_1mo_ago: null,
        price_pct_change: null,
        median_rent_now: null,
        median_rent_1mo_ago: null,
        rent_pct_change: null,
        sample_size: null,
        tier,
        has_prior_observation: false,
      })
      continue
    }

    const { wrapped, error, cliMissing: missing } = await pullMarkets(zip)
    if (missing) cliMissing = true
    if (error) {
      errors.push(error)
      out.push({
        zip,
        median_price_now: null,
        median_price_1mo_ago: null,
        price_pct_change: null,
        median_rent_now: null,
        median_rent_1mo_ago: null,
        rent_pct_change: null,
        sample_size: null,
        tier,
        has_prior_observation: false,
      })
      continue
    }
    if (!wrapped) {
      out.push({
        zip,
        median_price_now: null,
        median_price_1mo_ago: null,
        price_pct_change: null,
        median_rent_now: null,
        median_rent_1mo_ago: null,
        rent_pct_change: null,
        sample_size: null,
        tier,
        has_prior_observation: false,
      })
      continue
    }

    if (wrapped.budget_exhausted) {
      budgetExhausted = true
      out.push({
        zip,
        median_price_now: null,
        median_price_1mo_ago: null,
        price_pct_change: null,
        median_rent_now: null,
        median_rent_1mo_ago: null,
        rent_pct_change: null,
        sample_size: null,
        tier,
        has_prior_observation: false,
      })
      continue
    }

    const payload = (wrapped.data ?? {}) as MarketsPayload
    const medianPrice = typeof payload.saleData?.medianPrice === 'number' ? payload.saleData.medianPrice : null
    const medianRent = typeof payload.rentalData?.medianRent === 'number' ? payload.rentalData.medianRent : null
    const sampleSize =
      typeof payload.saleData?.totalListings === 'number'
        ? payload.saleData.totalListings
        : typeof payload.rentalData?.totalListings === 'number'
          ? payload.rentalData.totalListings
          : null

    out.push({
      zip,
      median_price_now: medianPrice,
      median_price_1mo_ago: null,
      price_pct_change: null,
      median_rent_now: medianRent,
      median_rent_1mo_ago: null,
      rent_pct_change: null,
      sample_size: sampleSize,
      tier,
      has_prior_observation: false,
    })
  }

  const raw_data = {
    collected_at_ms: now,
    zips: out,
    budget_exhausted: budgetExhausted,
  }

  logger.info(
    {
      pawId: ctx.pawId,
      zipCount: out.length,
      budgetExhausted,
      cliMissing,
    },
    '[broker-market-deltas] collect complete (v1 stub)',
  )

  return {
    raw_data,
    collected_at: now,
    collector: 'broker-market-deltas',
    errors: errors.length ? errors : undefined,
  }
}
