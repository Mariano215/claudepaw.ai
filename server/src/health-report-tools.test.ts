import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database
let botDb: Database.Database // not used here but health-report uses it

vi.mock('./db.js', () => ({
  getTelemetryDb: () => testDb,
  getBotDb: () => botDb,
  getDb: () => botDb,
}))

vi.mock('./system-state.js', () => ({
  getKillSwitch: () => null,
}))

function hoursAgo(h: number): number {
  return Date.now() - h * 60 * 60 * 1000
}

function seedEvent(
  db: Database.Database,
  eventId: string,
  receivedAt: number,
  projectId = 'proj-a',
  agentId: string | null = 'scout',
): void {
  db.prepare(
    `INSERT INTO agent_events
       (event_id, received_at, project_id, agent_id, total_cost_usd,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        is_error, source, executed_provider)
     VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 'scheduler', 'claude_desktop')`,
  ).run(eventId, receivedAt, projectId, agentId)
}

function seedTool(
  db: Database.Database,
  eventId: string,
  toolName: string,
  startedAt: number,
  durationMs: number,
  success: 0 | 1 = 1,
): void {
  db.prepare(
    `INSERT INTO tool_calls
       (event_id, tool_use_id, tool_name, started_at, duration_ms, success)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(eventId, `tu-${Math.random()}`, toolName, startedAt, durationMs, success)
}

beforeAll(() => {
  testDb = new Database(':memory:')
  botDb = new Database(':memory:')

  testDb.exec(`
    CREATE TABLE agent_events (
      event_id TEXT PRIMARY KEY,
      received_at INTEGER,
      project_id TEXT,
      agent_id TEXT,
      total_cost_usd REAL,
      input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      is_error INTEGER DEFAULT 0,
      source TEXT,
      executed_provider TEXT
    );
    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL REFERENCES agent_events(event_id),
      tool_use_id TEXT,
      tool_name TEXT,
      started_at INTEGER,
      duration_ms INTEGER,
      success INTEGER,
      error TEXT,
      tool_input_summary TEXT,
      parent_tool_use_id TEXT,
      elapsed_seconds REAL
    );
    CREATE INDEX idx_tool_calls_name_started ON tool_calls(tool_name, started_at);
  `)
})

beforeEach(() => {
  testDb.prepare('DELETE FROM tool_calls').run()
  testDb.prepare('DELETE FROM agent_events').run()
})

describe('buildToolUsage', () => {
  it('returns totals, per-tool rows, and a top-5 summary for the window', async () => {
    const { buildToolUsage } = await import('./health-report.js')

    const now = Date.now()
    const tenMinAgo = now - 10 * 60 * 1000
    seedEvent(testDb, 'ev-1', tenMinAgo, 'proj-a', 'scout')
    seedEvent(testDb, 'ev-2', tenMinAgo, 'proj-a', 'builder')

    // 4 Bash calls, 1 failure (scout:3 + builder:1)
    seedTool(testDb, 'ev-1', 'Bash', tenMinAgo, 120)
    seedTool(testDb, 'ev-1', 'Bash', tenMinAgo, 140)
    seedTool(testDb, 'ev-1', 'Bash', tenMinAgo, 300, 0) // failure
    seedTool(testDb, 'ev-2', 'Bash', tenMinAgo, 90)
    // 2 Read calls
    seedTool(testDb, 'ev-1', 'Read', tenMinAgo, 50)
    seedTool(testDb, 'ev-2', 'Read', tenMinAgo, 60)
    // 1 WebFetch call
    seedTool(testDb, 'ev-2', 'WebFetch', tenMinAgo, 2000)

    const report = buildToolUsage({ hours: 24 })

    expect(report.total_calls).toBe(7)
    expect(report.total_failures).toBe(1)
    expect(report.unique_tools).toBe(3)

    const bash = report.tools.find(t => t.tool_name === 'Bash')!
    expect(bash).toBeDefined()
    expect(bash.calls).toBe(4)
    expect(bash.failures).toBe(1)
    // Mean of [120, 140, 300, 90] = 162.5, rounded to 163 by the report.
    expect(bash.avg_duration_ms).toBe(163)

    expect(report.top_5_tools[0].tool_name).toBe('Bash')
    expect(report.top_5_tools[0].calls).toBe(4)
  })

  it('produces an agent × tool matrix', async () => {
    const { buildToolUsage } = await import('./health-report.js')

    const now = Date.now()
    const tenMinAgo = now - 10 * 60 * 1000
    seedEvent(testDb, 'ev-s', tenMinAgo, 'proj-a', 'scout')
    seedEvent(testDb, 'ev-b', tenMinAgo, 'proj-a', 'builder')
    seedEvent(testDb, 'ev-x', tenMinAgo, 'proj-a', null) // null agent

    seedTool(testDb, 'ev-s', 'Bash', tenMinAgo, 100)
    seedTool(testDb, 'ev-s', 'Bash', tenMinAgo, 100)
    seedTool(testDb, 'ev-b', 'Bash', tenMinAgo, 100)
    seedTool(testDb, 'ev-s', 'Read', tenMinAgo, 100)
    seedTool(testDb, 'ev-x', 'WebFetch', tenMinAgo, 100)

    const report = buildToolUsage({ hours: 24 })

    expect(report.matrix.agents).toContain('scout')
    expect(report.matrix.agents).toContain('builder')
    // null agent rendered as a fixed sentinel label
    expect(report.matrix.agents).toContain('(unattributed)')

    const bashRow = report.matrix.rows.find(r => r.tool_name === 'Bash')!
    expect(bashRow.cells.scout).toBe(2)
    expect(bashRow.cells.builder).toBe(1)
    expect(bashRow.total).toBe(3)

    const readRow = report.matrix.rows.find(r => r.tool_name === 'Read')!
    expect(readRow.cells.scout).toBe(1)
    expect(readRow.cells.builder ?? 0).toBe(0)
  })

  it('filters by hours window -- rows outside the window are excluded', async () => {
    const { buildToolUsage } = await import('./health-report.js')

    const tenMinAgo = hoursAgo(0.17)
    const thirtyHoursAgo = hoursAgo(30)
    seedEvent(testDb, 'ev-recent', tenMinAgo)
    seedEvent(testDb, 'ev-old', thirtyHoursAgo)

    seedTool(testDb, 'ev-recent', 'Bash', tenMinAgo, 100)
    seedTool(testDb, 'ev-old', 'Bash', thirtyHoursAgo, 100)

    const report24 = buildToolUsage({ hours: 24 })
    expect(report24.total_calls).toBe(1)

    const report48 = buildToolUsage({ hours: 48 })
    expect(report48.total_calls).toBe(2)
  })

  it('honors project_id filter', async () => {
    const { buildToolUsage } = await import('./health-report.js')

    const tenMinAgo = hoursAgo(0.17)
    seedEvent(testDb, 'ev-a', tenMinAgo, 'proj-a', 'scout')
    seedEvent(testDb, 'ev-b', tenMinAgo, 'proj-b', 'scout')

    seedTool(testDb, 'ev-a', 'Bash', tenMinAgo, 100)
    seedTool(testDb, 'ev-b', 'Bash', tenMinAgo, 100)
    seedTool(testDb, 'ev-b', 'Read', tenMinAgo, 100)

    const filtered = buildToolUsage({ hours: 24, project_id: 'proj-a' })
    expect(filtered.total_calls).toBe(1)
    expect(filtered.unique_tools).toBe(1)
  })

  it('honors allowedProjectIds scoping (empty array = no access = empty report)', async () => {
    const { buildToolUsage } = await import('./health-report.js')

    const tenMinAgo = hoursAgo(0.17)
    seedEvent(testDb, 'ev-a', tenMinAgo, 'proj-a', 'scout')
    seedTool(testDb, 'ev-a', 'Bash', tenMinAgo, 100)

    const report = buildToolUsage({ hours: 24, allowedProjectIds: [] })
    expect(report.total_calls).toBe(0)
    expect(report.tools).toEqual([])
  })

  it('honors allowedProjectIds scoping (restricts to listed projects)', async () => {
    const { buildToolUsage } = await import('./health-report.js')

    const tenMinAgo = hoursAgo(0.17)
    seedEvent(testDb, 'ev-a', tenMinAgo, 'proj-a', 'scout')
    seedEvent(testDb, 'ev-b', tenMinAgo, 'proj-b', 'scout')

    seedTool(testDb, 'ev-a', 'Bash', tenMinAgo, 100)
    seedTool(testDb, 'ev-b', 'Bash', tenMinAgo, 100)

    const report = buildToolUsage({ hours: 24, allowedProjectIds: ['proj-b'] })
    expect(report.total_calls).toBe(1)
  })
})
