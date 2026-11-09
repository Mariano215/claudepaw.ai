import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

let db: InstanceType<typeof Database>
const cards: Array<Record<string, unknown>> = []

vi.mock('../../db.js', () => ({ getDb: () => db }))
vi.mock('../../action-items.js', () => ({
  createActionItem: vi.fn((input: Record<string, unknown>) => { cards.push(input); return `card-${cards.length}` }),
}))
vi.mock('../../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
  cards.length = 0
  db = new Database(':memory:')
  db.exec(`CREATE TABLE deals (id TEXT PRIMARY KEY, project_id TEXT, address TEXT, zip TEXT, list_price REAL,
    max_offer REAL, est_arv REAL, est_rehab REAL, est_rent_monthly REAL, est_str_adr REAL, est_str_occupancy REAL,
    est_cap_rate REAL, est_coc REAL, deal_type TEXT, status TEXT, severity INTEGER, notes TEXT,
    created_at INTEGER, updated_at INTEGER)`)
  db.prepare(`INSERT INTO deals (id, project_id, address, status, notes, created_at, updated_at)
    VALUES ('d1','broker','1 A St','sourced','scout note',1,1)`).run()
  db.prepare(`INSERT INTO deals (id, project_id, address, status, notes, created_at, updated_at)
    VALUES ('d2','broker','2 B St','sourced','scout note',1,1)`).run()
})

const OUT = (actions: unknown[]) => '```json\n' + JSON.stringify({ actions }) + '\n```'

describe('broker-deal-underwrite-persist', () => {
  it('moves a passing deal to under-review, writes the numbers, and opens one card', async () => {
    const { brokerDealUnderwritePersistHandler } = await import('./broker-deal-underwrite-persist.js')
    await brokerDealUnderwritePersistHandler('c1', 'broker-deal-underwriter', 'broker', OUT([
      { type: 'underwrite', deal_id: 'd1', verdict: 'pass', max_offer: 132000, est_arv: 240000,
        est_rehab: 55000, est_rent_monthly: 2100, dscr: 1.41, coc: 11.2, severity: 2,
        summary: 'BRRRR clears at 69 percent of ARV, DSCR 1.41 at stressed rate.' },
    ]))

    const row = db.prepare('SELECT * FROM deals WHERE id = ?').get('d1') as Record<string, unknown>
    expect(row.status).toBe('under-review')
    expect(row.max_offer).toBe(132000)
    expect(row.est_arv).toBe(240000)
    expect(String(row.notes)).toContain('DSCR 1.41')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ project_id: 'broker', source: 'broker.underwrite', proposed_by: 'deal-analyzer' })
  })

  it('moves a failing deal to passed and opens no card', async () => {
    const { brokerDealUnderwritePersistHandler } = await import('./broker-deal-underwrite-persist.js')
    await brokerDealUnderwritePersistHandler('c1', 'broker-deal-underwriter', 'broker', OUT([
      { type: 'underwrite', deal_id: 'd2', verdict: 'fail', severity: 5,
        summary: 'DSCR 1.18 against the 1.30 floor at stressed rate.' },
    ]))

    const row = db.prepare('SELECT status, notes FROM deals WHERE id = ?').get('d2') as { status: string; notes: string }
    expect(row.status).toBe('passed')
    expect(row.notes).toContain('1.18')
    expect(cards).toHaveLength(0)
  })

  it('ignores an unknown deal id and an empty action list without throwing', async () => {
    const { brokerDealUnderwritePersistHandler } = await import('./broker-deal-underwrite-persist.js')
    await expect(brokerDealUnderwritePersistHandler('c1', 'p', 'broker', OUT([{ type: 'underwrite', deal_id: 'nope', verdict: 'pass', summary: 's' }]))).resolves.toBeUndefined()
    await expect(brokerDealUnderwritePersistHandler('c1', 'p', 'broker', OUT([]))).resolves.toBeUndefined()
    await expect(brokerDealUnderwritePersistHandler('c1', 'p', 'broker', 'no json here')).resolves.toBeUndefined()
    expect(cards).toHaveLength(0)
  })
})
