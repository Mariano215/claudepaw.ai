import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { insertChatEventIntoDb } from './db.js'

let testDb: Database.Database

beforeAll(() => {
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  testDb.exec(`
    CREATE TABLE agent_events (
      event_id TEXT PRIMARY KEY,
      project_id TEXT,
      received_at INTEGER,
      chat_id TEXT, session_id TEXT,
      memory_injected_at INTEGER, agent_started_at INTEGER, agent_ended_at INTEGER, response_sent_at INTEGER,
      prompt_summary TEXT, result_summary TEXT, model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
      total_cost_usd REAL, duration_ms REAL, duration_api_ms REAL, num_turns INTEGER, is_error INTEGER,
      source TEXT, model_usage_json TEXT, prompt_text TEXT, result_text TEXT, agent_id TEXT,
      requested_provider TEXT, executed_provider TEXT, provider_fallback_applied INTEGER
    );
    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL REFERENCES agent_events(event_id),
      tool_use_id TEXT, tool_name TEXT,
      parent_tool_use_id TEXT, elapsed_seconds REAL,
      started_at INTEGER, duration_ms INTEGER,
      tool_input_summary TEXT, success INTEGER, error TEXT
    );
  `)
})

beforeEach(() => {
  testDb.prepare('DELETE FROM tool_calls').run()
  testDb.prepare('DELETE FROM agent_events').run()
})

describe('insertChatEvent with tool_calls', () => {
  it('persists the parent event plus each tool_calls row in one shot', async () => {
    insertChatEventIntoDb(testDb, {
      event_id: 'evt-1',
      project_id: 'proj-a',
      received_at: Date.now(),
      is_error: 0,
      tool_calls: [
        {
          tool_use_id: 'toolu_1',
          tool_name: 'Bash',
          started_at: Date.now() - 100,
          duration_ms: 80,
          tool_input_summary: '{"command":"ls"}',
          success: 1,
          error: null,
        },
        {
          tool_use_id: 'toolu_2',
          tool_name: 'Read',
          started_at: Date.now() - 50,
          duration_ms: 10,
          tool_input_summary: '{"file_path":"/tmp/x"}',
          success: 1,
        },
      ],
    })

    const evt = testDb.prepare(`SELECT event_id, project_id FROM agent_events WHERE event_id = ?`).get('evt-1') as any
    expect(evt.event_id).toBe('evt-1')

    const tools = testDb.prepare(`SELECT tool_name, duration_ms, success FROM tool_calls WHERE event_id = ? ORDER BY id`).all('evt-1') as any[]
    expect(tools).toHaveLength(2)
    expect(tools[0].tool_name).toBe('Bash')
    expect(tools[1].tool_name).toBe('Read')
    expect(tools[0].duration_ms).toBe(80)
    expect(tools[0].success).toBe(1)
  })

  it('tolerates missing tool_calls field (payload from older bot versions)', async () => {
    insertChatEventIntoDb(testDb, {
      event_id: 'evt-2',
      project_id: 'proj-a',
      received_at: Date.now(),
      is_error: 0,
      // no tool_calls field at all
    })

    const evt = testDb.prepare(`SELECT event_id FROM agent_events WHERE event_id = ?`).get('evt-2') as any
    expect(evt.event_id).toBe('evt-2')
    const toolCount = testDb.prepare(`SELECT COUNT(*) as c FROM tool_calls WHERE event_id = ?`).get('evt-2') as { c: number }
    expect(toolCount.c).toBe(0)
  })

  it('tolerates tool_calls being the wrong type (non-array)', async () => {
    insertChatEventIntoDb(testDb, {
      event_id: 'evt-3',
      project_id: 'proj-a',
      received_at: Date.now(),
      is_error: 0,
      tool_calls: 'not-an-array' as any,
    })

    const evt = testDb.prepare(`SELECT event_id FROM agent_events WHERE event_id = ?`).get('evt-3') as any
    expect(evt.event_id).toBe('evt-3')
  })

  it('caps a runaway tool_calls array at MAX_TOOL_CALLS_PER_EVENT (500)', () => {
    const tooMany = Array.from({ length: 10_000 }, (_, i) => ({
      tool_use_id: 'toolu_' + i,
      tool_name: 'Bash',
      started_at: Date.now(),
      success: 1,
    }))

    insertChatEventIntoDb(testDb, {
      event_id: 'evt-dos',
      project_id: 'proj-a',
      received_at: Date.now(),
      is_error: 0,
      tool_calls: tooMany,
    })

    const count = testDb.prepare(`SELECT COUNT(*) as c FROM tool_calls WHERE event_id = ?`).get('evt-dos') as { c: number }
    expect(count.c).toBeLessThanOrEqual(500)
    expect(count.c).toBeGreaterThan(0)
  })

  it('normalizes success field: truthy -> 1, falsy -> 0, null -> null (pending)', async () => {
    insertChatEventIntoDb(testDb, {
      event_id: 'evt-4',
      project_id: 'proj-a',
      received_at: Date.now(),
      is_error: 0,
      tool_calls: [
        { tool_use_id: 'a', tool_name: 'A', success: 1 },
        { tool_use_id: 'b', tool_name: 'B', success: 0 },
        { tool_use_id: 'c', tool_name: 'C', success: null },
      ],
    })

    const tools = testDb.prepare(`SELECT tool_name, success FROM tool_calls WHERE event_id = ? ORDER BY tool_name`).all('evt-4') as any[]
    expect(tools.find(t => t.tool_name === 'A').success).toBe(1)
    expect(tools.find(t => t.tool_name === 'B').success).toBe(0)
    expect(tools.find(t => t.tool_name === 'C').success).toBeNull()
  })
})
