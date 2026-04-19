import { describe, it, expect, beforeAll, vi } from 'vitest'
import Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// In-memory DB wired up before the module under test is loaded
// ---------------------------------------------------------------------------

let testDb: Database.Database

vi.mock('./db.js', () => ({
  getTelemetryDb: () => testDb,
}))

// Helper: month start in ms (first day of current month at 00:00 local)
function monthStart(): number {
  const d = new Date()
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Helper: day start in ms (today at 00:00 local)
function dayStart(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

// Seed a single agent_events row
function seedEvent(
  db: Database.Database,
  eventId: string,
  receivedAt: number,
  costUsd: number,
  projectId = 'proj-test',
): void {
  db.prepare(
    `INSERT INTO agent_events
       (event_id, received_at, project_id, total_cost_usd,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
     VALUES (?, ?, ?, ?, 0, 0, 0, 0)`,
  ).run(eventId, receivedAt, projectId, costUsd)
}

beforeAll(() => {
  testDb = new Database(':memory:')
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS agent_events (
      event_id              TEXT PRIMARY KEY,
      received_at           INTEGER,
      project_id            TEXT,
      total_cost_usd        REAL,
      input_tokens          INTEGER,
      output_tokens         INTEGER,
      cache_read_tokens     INTEGER,
      cache_creation_tokens INTEGER
    )
  `)

  // Scenario A: 1 USD MTD, proj-1usd
  seedEvent(testDb, 'ev-a1', monthStart() + 1_000, 1.0, 'proj-1usd')

  // Scenario B: 8.5 USD MTD, proj-85pct
  seedEvent(testDb, 'ev-b1', monthStart() + 2_000, 8.5, 'proj-85pct')

  // Scenario C: 12 USD MTD, proj-over
  seedEvent(testDb, 'ev-c1', monthStart() + 3_000, 12.0, 'proj-over')

  // Scenario D: 6 USD today + daily cap 5, proj-dailyhit
  seedEvent(testDb, 'ev-d1', dayStart() + 5_000, 6.0, 'proj-dailyhit')

  // Scenario E: 3 USD MTD, proj-capdivzero (for cap=0 test)
  seedEvent(testDb, 'ev-e1', monthStart() + 4_000, 3.0, 'proj-capdivzero')

  // Scenario F: 100 USD MTD (100% of 100 monthly) + 5 USD today (100% of 5 daily) -> tie
  seedEvent(testDb, 'ev-f1', monthStart() + 6_000, 95.0, 'proj-tiebreak') // 95 + 5 today = 100 MTD
  seedEvent(testDb, 'ev-f2', dayStart() + 6_000, 5.0, 'proj-tiebreak')   // 5 USD today (100% of 5)
})

// Import after mock + beforeAll so testDb is ready before module init
const { computeCostGateStatus } = await import('./cost-gate.js')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeCostGateStatus', () => {
  it('no caps returns allow with percent_of_cap 0', () => {
    const status = computeCostGateStatus('proj-1usd', {
      monthly_cost_cap_usd: null,
      daily_cost_cap_usd: null,
    })
    expect(status.action).toBe('allow')
    expect(status.percent_of_cap).toBe(0)
    expect(status.triggering_cap).toBeNull()
  })

  it('1 USD MTD with 10 USD monthly cap returns allow + correct mtd_usd', () => {
    const status = computeCostGateStatus('proj-1usd', {
      monthly_cost_cap_usd: 10,
      daily_cost_cap_usd: null,
    })
    expect(status.action).toBe('allow')
    expect(status.mtd_usd).toBeCloseTo(1.0, 5)
    expect(status.percent_of_cap).toBe(10.0)
    expect(status.triggering_cap).toBe('monthly')
  })

  it('8.5 USD MTD with 10 USD cap returns override_to_ollama', () => {
    const status = computeCostGateStatus('proj-85pct', {
      monthly_cost_cap_usd: 10,
      daily_cost_cap_usd: null,
    })
    expect(status.action).toBe('override_to_ollama')
    expect(status.percent_of_cap).toBe(85.0)
    expect(status.triggering_cap).toBe('monthly')
  })

  it('12 USD MTD with 10 USD cap returns refuse', () => {
    const status = computeCostGateStatus('proj-over', {
      monthly_cost_cap_usd: 10,
      daily_cost_cap_usd: null,
    })
    expect(status.action).toBe('refuse')
    expect(status.percent_of_cap).toBeGreaterThanOrEqual(100)
    expect(status.triggering_cap).toBe('monthly')
  })

  it('6 USD today with 5 USD daily cap + 100 USD monthly cap returns refuse triggered by daily', () => {
    const status = computeCostGateStatus('proj-dailyhit', {
      monthly_cost_cap_usd: 100,
      daily_cost_cap_usd: 5,
    })
    expect(status.action).toBe('refuse')
    expect(status.triggering_cap).toBe('daily')
    expect(status.today_usd).toBeCloseTo(6.0, 5)
  })

  it('cap=0 with nonzero spend returns refuse with percent_of_cap >= 100', () => {
    const status = computeCostGateStatus('proj-capdivzero', {
      monthly_cost_cap_usd: 0,
      daily_cost_cap_usd: null,
    })
    expect(status.action).toBe('refuse')
    expect(status.percent_of_cap).toBeGreaterThanOrEqual(100)
    expect(status.triggering_cap).toBe('monthly')
  })

  it('equal monthly and daily percents return triggering_cap monthly (tie-break)', () => {
    // 100 USD MTD vs 100 USD monthly cap (100%) AND 5 USD today vs 5 USD daily cap (100%) - tie
    const status = computeCostGateStatus('proj-tiebreak', {
      monthly_cost_cap_usd: 100,
      daily_cost_cap_usd: 5,
    })
    expect(status.action).toBe('refuse')
    expect(status.triggering_cap).toBe('monthly')
    expect(status.percent_of_cap).toBeGreaterThanOrEqual(100)
  })
})
