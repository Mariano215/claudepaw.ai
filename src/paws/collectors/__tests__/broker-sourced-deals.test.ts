import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

let db: InstanceType<typeof Database>
vi.mock('../../../db.js', () => ({ getDb: () => db }))
vi.mock('../../../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const budget = { budget_exhausted: false, calls_this_month: 3, cap: 45, remaining: 42 }
let cliCalls = 0
const cliOptions: Array<Record<string, unknown>> = []
vi.mock('node:child_process', () => ({
  execFile: (_bin: string, args: string[], o: Record<string, unknown>, cb: (e: unknown, r: { stdout: string }) => void) => {
    cliCalls++
    cliOptions.push(o)
    if (args.includes('budget')) cb(null, { stdout: JSON.stringify(budget) + '\n' })
    else cb(null, { stdout: JSON.stringify({ ok: true, budget_exhausted: false, data: { dataByBedrooms: [{ bedrooms: 3, averageRent: 1800 }] } }) + '\n' })
  },
}))

function seedDeals(): void {
  db.exec(`CREATE TABLE deals (id TEXT PRIMARY KEY, project_id TEXT, source_paw_id TEXT, address TEXT, zip TEXT,
    list_price REAL, max_offer REAL, est_arv REAL, est_rehab REAL, est_rent_monthly REAL, est_str_adr REAL,
    est_str_occupancy REAL, est_cap_rate REAL, est_coc REAL, deal_type TEXT, status TEXT, severity INTEGER,
    notes TEXT, created_at INTEGER, updated_at INTEGER)`)
  const ins = db.prepare(`INSERT INTO deals (id, project_id, address, zip, list_price, deal_type, status, severity, notes, created_at, updated_at)
    VALUES (?, 'broker', ?, ?, ?, 'str', ?, ?, 'n', 1, 1)`)
  ins.run('d5', '5 A St', '19103', 100000, 'sourced', 5)
  ins.run('d4', '4 B St', '19103', 200000, 'sourced', 4)
  ins.run('d3', '3 C St', '08226', 300000, 'sourced', 3)
  ins.run('dx', '9 X St', '19103', 400000, 'under-review', 5)
}

beforeEach(() => {
  db = new Database(':memory:')
  seedDeals()
  budget.budget_exhausted = false
  cliCalls = 0
  cliOptions.length = 0
})

describe('broker-sourced-deals collector', () => {
  it('returns only sourced deals, worst-first, capped by the limit', async () => {
    const { brokerSourcedDealsCollector } = await import('../broker-sourced-deals.js')
    const res = await brokerSourcedDealsCollector({ pawId: 'p', projectId: 'broker', args: { limit: 2 } })
    const raw = res.raw_data as { deals: Array<{ id: string }>; sourced_total: number }
    expect(raw.deals.map(d => d.id)).toEqual(['d5', 'd4'])
    expect(raw.sourced_total).toBe(3)
  })

  it('pulls market rent once per distinct zip', async () => {
    const { brokerSourcedDealsCollector } = await import('../broker-sourced-deals.js')
    const res = await brokerSourcedDealsCollector({ pawId: 'p', projectId: 'broker', args: { limit: 5 } })
    const raw = res.raw_data as { market_rent_by_zip: Record<string, unknown> }
    expect(Object.keys(raw.market_rent_by_zip).sort()).toEqual(['08226', '19103'])
  })

  it('reports comps_available false and pulls no market data when the budget is exhausted', async () => {
    budget.budget_exhausted = true
    const { brokerSourcedDealsCollector } = await import('../broker-sourced-deals.js')
    const res = await brokerSourcedDealsCollector({ pawId: 'p', projectId: 'broker', args: { limit: 5 } })
    const raw = res.raw_data as { comps_available: boolean; market_rent_by_zip: Record<string, unknown> }
    expect(raw.comps_available).toBe(false)
    expect(raw.market_rent_by_zip).toEqual({})
  })

  it('does not throw when the DB layer throws, and reports empty results plus an error', async () => {
    db.prepare = () => { throw new Error('db boom') }
    const { brokerSourcedDealsCollector } = await import('../broker-sourced-deals.js')
    const res = await brokerSourcedDealsCollector({ pawId: 'p', projectId: 'broker', args: { limit: 5 } })
    const raw = res.raw_data as { deals: unknown[]; sourced_total: number }
    expect(raw.deals).toEqual([])
    expect(raw.sourced_total).toBe(0)
    expect(res.errors).toBeDefined()
    expect(res.errors!.some(e => e.includes('db boom'))).toBe(true)
  })

  it('skips the Rentcast budget check entirely when the sourced batch is empty', async () => {
    db.exec('DELETE FROM deals')
    const { brokerSourcedDealsCollector } = await import('../broker-sourced-deals.js')
    const res = await brokerSourcedDealsCollector({ pawId: 'p', projectId: 'broker', args: { limit: 5 } })
    const raw = res.raw_data as { deals: unknown[]; comps_available: boolean }
    expect(raw.deals).toEqual([])
    expect(cliCalls).toBe(0)
  })

  it('gives every rentcast-cli call a 20s timeout so a hung call cannot stall the cycle', async () => {
    const { brokerSourcedDealsCollector } = await import('../broker-sourced-deals.js')
    await brokerSourcedDealsCollector({ pawId: 'p', projectId: 'broker', args: { limit: 5 } })
    expect(cliOptions.length).toBeGreaterThan(0)
    for (const o of cliOptions) expect(o.timeout).toBe(20_000)
  })

  it('produces byte-identical raw_data across two consecutive quiet runs', async () => {
    db.exec('DELETE FROM deals')
    const { brokerSourcedDealsCollector } = await import('../broker-sourced-deals.js')
    const first = await brokerSourcedDealsCollector({ pawId: 'p', projectId: 'broker', args: { limit: 5 } })
    const second = await brokerSourcedDealsCollector({ pawId: 'p', projectId: 'broker', args: { limit: 5 } })
    expect(JSON.stringify(second.raw_data)).toBe(JSON.stringify(first.raw_data))
  })
})
