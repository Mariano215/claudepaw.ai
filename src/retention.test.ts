import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `claudepaw-retention-test-${process.pid}`)

vi.mock('./config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const dir = path.join(os.tmpdir(), `claudepaw-retention-test-${process.pid}`)
  return { STORE_DIR: dir }
})

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('./env.js', () => ({
  readEnvFile: () => ({ AGENT_EVENTS_RETENTION_DAYS: '30' }),
}))

import { initTelemetryDatabase, getTelemetryDb } from './telemetry-db.js'
import { purgeOldAgentEvents } from './retention.js'

describe('purgeOldAgentEvents', () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    initTelemetryDatabase()
  })

  beforeEach(() => {
    const db = getTelemetryDb()
    db.prepare('DELETE FROM tool_calls').run()
    db.prepare('DELETE FROM agent_events').run()
  })

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('deletes tool_calls rows whose parent agent_event is purged', () => {
    const db = getTelemetryDb()
    const now = Date.now()
    const old = now - 45 * 24 * 60 * 60 * 1000 // 45 days ago, past 30d retention

    // Old parent event (will be purged) + its 3 tool_calls
    db.prepare(`INSERT INTO agent_events (event_id, project_id, received_at) VALUES (?, ?, ?)`)
      .run('evt-old', 'proj-1', old)
    db.prepare(`INSERT INTO tool_calls (event_id, tool_use_id, tool_name, started_at) VALUES (?, ?, ?, ?)`)
      .run('evt-old', 'toolu_o1', 'Bash', old)
    db.prepare(`INSERT INTO tool_calls (event_id, tool_use_id, tool_name, started_at) VALUES (?, ?, ?, ?)`)
      .run('evt-old', 'toolu_o2', 'Read', old)
    db.prepare(`INSERT INTO tool_calls (event_id, tool_use_id, tool_name, started_at) VALUES (?, ?, ?, ?)`)
      .run('evt-old', 'toolu_o3', 'Bash', old)

    // Fresh parent + tool_calls (must survive the purge)
    db.prepare(`INSERT INTO agent_events (event_id, project_id, received_at) VALUES (?, ?, ?)`)
      .run('evt-new', 'proj-1', now)
    db.prepare(`INSERT INTO tool_calls (event_id, tool_use_id, tool_name, started_at) VALUES (?, ?, ?, ?)`)
      .run('evt-new', 'toolu_n1', 'Bash', now)

    const result = purgeOldAgentEvents()
    expect(result.deleted).toBe(1)

    // Orphan tool_calls from evt-old must be gone
    const orphans = db.prepare(`SELECT COUNT(*) as c FROM tool_calls WHERE event_id = ?`).get('evt-old') as { c: number }
    expect(orphans.c).toBe(0)

    // tool_calls for evt-new must still be there
    const survivors = db.prepare(`SELECT COUNT(*) as c FROM tool_calls WHERE event_id = ?`).get('evt-new') as { c: number }
    expect(survivors.c).toBe(1)
  })

  it('is a no-op when there are no old events', () => {
    const db = getTelemetryDb()
    db.prepare(`INSERT INTO agent_events (event_id, project_id, received_at) VALUES (?, ?, ?)`)
      .run('evt-fresh', 'proj-1', Date.now())

    const result = purgeOldAgentEvents()
    expect(result.deleted).toBe(0)

    const events = db.prepare(`SELECT COUNT(*) as c FROM agent_events`).get() as { c: number }
    expect(events.c).toBe(1)
  })
})
