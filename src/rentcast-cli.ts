#!/usr/bin/env tsx
// Rentcast API wrapper with cache + monthly budget gate.
//
// The Property Scout paw would otherwise burn through the Developer tier
// (50 calls/month) in a single Monday run. This CLI:
//   - Serves cached responses when they're still fresh (listings 24h,
//     markets 30d; Rentcast listings don't change hour-to-hour and market
//     rent stats are slow-moving).
//   - Counts real API calls for the current calendar month and refuses
//     once the cap is hit, returning {"budget_exhausted": true, ...} so
//     the paw prompt can branch to web-only fallback.
//   - Pulls the API key from the credential store (same `default/rentcast`
//     entry the old inline-curl approach used).
//
// Usage (invoked from paw OBSERVE/ACT phases):
//   node dist/rentcast-cli.js listings --zip 19081 [--max-price 310000] [--status Active]
//   node dist/rentcast-cli.js markets  --zip 19081
//   node dist/rentcast-cli.js budget
//   node dist/rentcast-cli.js reset-cache   # clear cache only (keeps call log)
//
// Exit codes:
//   0 — success (may include cached response or budget_exhausted signal)
//   1 — invalid args / missing API key
//   2 — upstream HTTP error (non-2xx, still logs to call_log)

import { initDatabase, getDb, checkpointAndCloseDatabase } from './db.js'
import { getCredential, initCredentialStore } from './credentials.js'

// Cap is configurable via env but defaults to 45 (headroom under the
// Developer tier's 50/month so on-demand analyzer calls don't tip us over).
const MONTHLY_CAP = Number(process.env.RENTCAST_MONTHLY_CAP) || 45

// Per-endpoint TTLs (ms). Listings change when an agent flips a status or
// price; 24h is plenty for a weekly paw. Markets are slow-moving zip-level
// medians published monthly-ish; 30d is safe.
const TTL_LISTINGS_MS = 24 * 60 * 60 * 1000
const TTL_MARKETS_MS = 30 * 24 * 60 * 60 * 1000

const BASE_URL = 'https://api.rentcast.io/v1'

type CacheRow = { response_json: string; cached_at: number; ttl_ms: number }

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string> } {
  const [cmd, ...rest] = argv
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (!tok.startsWith('--')) continue
    const name = tok.slice(2)
    const next = rest[i + 1]
    if (next && !next.startsWith('--')) {
      flags[name] = next
      i++
    } else {
      flags[name] = 'true'
    }
  }
  return { cmd, flags }
}

function firstOfMonthMs(now: number = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0)
}

function countCallsThisMonth(): number {
  const since = firstOfMonthMs()
  const row = getDb()
    .prepare('SELECT COUNT(*) as n FROM rentcast_call_log WHERE called_at >= ?')
    .get(since) as { n: number }
  return row.n
}

function getCache(key: string): unknown | null {
  const row = getDb()
    .prepare('SELECT response_json, cached_at, ttl_ms FROM rentcast_cache WHERE key = ?')
    .get(key) as CacheRow | undefined
  if (!row) return null
  if (Date.now() - row.cached_at > row.ttl_ms) return null
  try {
    return JSON.parse(row.response_json)
  } catch {
    return null
  }
}

function setCache(key: string, value: unknown, ttlMs: number): void {
  getDb()
    .prepare(
      `INSERT INTO rentcast_cache (key, response_json, cached_at, ttl_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         response_json = excluded.response_json,
         cached_at = excluded.cached_at,
         ttl_ms = excluded.ttl_ms`,
    )
    .run(key, JSON.stringify(value), Date.now(), ttlMs)
}

function logCall(endpoint: string, query: string, statusCode: number, bytes: number): void {
  getDb()
    .prepare(
      'INSERT INTO rentcast_call_log (endpoint, query, called_at, status_code, bytes_returned) VALUES (?, ?, ?, ?, ?)',
    )
    .run(endpoint, query, Date.now(), statusCode, bytes)
}

function buildQuery(params: Record<string, string | undefined>): string {
  // Stable key: sort by key so cache hits are deterministic regardless of arg order.
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
  return entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
}

async function callRentcast(
  endpoint: 'listings' | 'markets',
  path: string,
  params: Record<string, string | undefined>,
  ttlMs: number,
): Promise<{ body: unknown; fromCache: boolean; budgetExhausted?: boolean; callsThisMonth: number }> {
  const query = buildQuery(params)
  const cacheKey = `${endpoint}:${query}`

  // 1. Cache hit — never touches the API
  const cached = getCache(cacheKey)
  if (cached !== null) {
    return { body: cached, fromCache: true, callsThisMonth: countCallsThisMonth() }
  }

  // 2. Budget gate
  const callsThisMonth = countCallsThisMonth()
  if (callsThisMonth >= MONTHLY_CAP) {
    return {
      body: { budget_exhausted: true, calls_this_month: callsThisMonth, cap: MONTHLY_CAP },
      fromCache: false,
      budgetExhausted: true,
      callsThisMonth,
    }
  }

  // 3. Real API call
  const apiKey = getCredential('default', 'rentcast', 'api_key')
  if (!apiKey) {
    throw new Error(
      "Missing Rentcast API key. Set via: cpaw cred set default rentcast api_key <YOUR_KEY>",
    )
  }

  const url = `${BASE_URL}${path}${query ? '?' + query : ''}`
  const res = await fetch(url, {
    headers: { 'X-Api-Key': apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  logCall(endpoint, query, res.status, Buffer.byteLength(text, 'utf8'))

  if (!res.ok) {
    throw new Error(`Rentcast ${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (err) {
    throw new Error(`Rentcast ${endpoint} returned non-JSON: ${text.slice(0, 200)}`)
  }

  setCache(cacheKey, body, ttlMs)
  return { body, fromCache: false, callsThisMonth: callsThisMonth + 1 }
}

async function cmdListings(flags: Record<string, string>): Promise<void> {
  const zip = flags.zip || flags.zipCode
  if (!zip) throw new Error('--zip is required for listings')
  const result = await callRentcast(
    'listings',
    '/listings/sale',
    {
      zipCode: zip,
      status: flags.status || 'Active',
      maxPrice: flags['max-price'] || flags.maxPrice,
    },
    TTL_LISTINGS_MS,
  )
  emit(result)
}

async function cmdMarkets(flags: Record<string, string>): Promise<void> {
  const zip = flags.zip || flags.zipCode
  if (!zip) throw new Error('--zip is required for markets')
  const result = await callRentcast(
    'markets',
    '/markets',
    { zipCode: zip },
    TTL_MARKETS_MS,
  )
  emit(result)
}

function emit(result: { body: unknown; fromCache: boolean; budgetExhausted?: boolean; callsThisMonth: number }): void {
  // Emit a single JSON line so the paw can grep/parse deterministically.
  const wrapped = {
    ok: !result.budgetExhausted,
    from_cache: result.fromCache,
    budget_exhausted: result.budgetExhausted ?? false,
    calls_this_month: result.callsThisMonth,
    cap: MONTHLY_CAP,
    data: result.body,
  }
  process.stdout.write(JSON.stringify(wrapped) + '\n')
}

function cmdBudget(): void {
  const calls = countCallsThisMonth()
  process.stdout.write(
    JSON.stringify({
      month_start_ms: firstOfMonthMs(),
      calls_this_month: calls,
      cap: MONTHLY_CAP,
      remaining: Math.max(0, MONTHLY_CAP - calls),
      budget_exhausted: calls >= MONTHLY_CAP,
    }) + '\n',
  )
}

function cmdResetCache(): void {
  const info = getDb().prepare('DELETE FROM rentcast_cache').run()
  process.stdout.write(JSON.stringify({ cleared: info.changes }) + '\n')
}

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2))

  initDatabase()
  initCredentialStore(getDb())

  try {
    switch (cmd) {
      case 'listings':
        await cmdListings(flags)
        break
      case 'markets':
        await cmdMarkets(flags)
        break
      case 'budget':
        cmdBudget()
        break
      case 'reset-cache':
        cmdResetCache()
        break
      default:
        process.stderr.write(
          'Usage: rentcast-cli <listings|markets|budget|reset-cache> [--zip N] [--max-price N] [--status Active]\n',
        )
        process.exit(1)
    }
  } finally {
    checkpointAndCloseDatabase()
  }
}

main().catch((err) => {
  process.stderr.write(`rentcast-cli error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(2)
})
