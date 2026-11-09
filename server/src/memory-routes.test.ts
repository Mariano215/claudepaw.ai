/**
 * memory-routes.test.ts
 *
 * End-to-end coverage of the three /api/v1/memory observability endpoints.
 * Uses the same in-memory DB + mock pattern as paws-routes.test.ts so the
 * authenticate + scopeProjects middleware chain is exercised.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import express from 'express'
import { createServer } from 'node:http'
import { request as nodeRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import {
  initUserStore,
  createUser,
  createUserToken,
  grantProjectMembership,
} from './users.js'
import { authenticate, scopeProjects } from './auth.js'

// ---------------------------------------------------------------------------
// Mock db.js: wire getBotDb/getBotDbWrite/getDb to the shared testDb.
// ---------------------------------------------------------------------------

let testDb: Database.Database

vi.mock('./db.js', async () => {
  const getTestDb = () => testDb
  return {
    getDb: vi.fn(() => getTestDb()),
    getBotDb: vi.fn(() => getTestDb()),
    getBotDbWrite: vi.fn(() => getTestDb()),
  }
})

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

function makeSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      global_role TEXT NOT NULL DEFAULT 'member' CHECK(global_role IN ('admin','member','bot')),
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS user_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
      granted_by_user_id INTEGER,
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      slug TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      icon TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      auto_archive_days INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0
    );

    -- Memory V2 tables (subset mirror of src/db.ts)
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      summary TEXT,
      project_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY,
      entity_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      valid_from INTEGER NOT NULL,
      valid_until INTEGER,
      source TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      project_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      user_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      tool_calls TEXT,
      token_count INTEGER,
      created_at INTEGER NOT NULL,
      summarized_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS chat_summaries (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      summary TEXT NOT NULL,
      key_topics TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS extraction_runs (
      id INTEGER PRIMARY KEY,
      run_type TEXT NOT NULL CHECK (run_type IN ('heuristic','batch_llm','summarization')),
      project_id TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      messages_processed INTEGER DEFAULT 0,
      entities_created INTEGER DEFAULT 0,
      observations_created INTEGER DEFAULT 0,
      summaries_created INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
      error TEXT
    );
  `)
}

// ---------------------------------------------------------------------------
// Import router AFTER mocks so getBotDb() resolves to testDb.
// ---------------------------------------------------------------------------

const { default: memoryRoutes } = await import('./memory-routes.js')

// ---------------------------------------------------------------------------
// App factory + HTTP helpers
// ---------------------------------------------------------------------------

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', (req, res, next) => authenticate(req, res, next))
  app.use('/api/v1', (req, res, next) => scopeProjects(req, res, next))
  app.use('/api/v1/memory', memoryRoutes)
  return app
}

type ServerHandle = { server: ReturnType<typeof createServer>; stop: () => Promise<void> }

function startServer(app: express.Express): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const s = createServer(app)
    s.listen(0, '127.0.0.1', () => {
      resolve({ server: s, stop: () => new Promise(res => s.close(() => res())) })
    })
    s.on('error', reject)
  })
}

type ReqResult = { status: number; body: unknown }

function httpReq(
  server: ReturnType<typeof createServer>,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<ReqResult> {
  const addr = server.address() as { port: number }
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers }
    if (bodyStr !== undefined) headers['Content-Length'] = String(Buffer.byteLength(bodyStr))
    const r = nodeRequest(
      { hostname: '127.0.0.1', port: addr.port, path, method, headers },
      (res: IncomingMessage) => {
        let raw = ''
        res.on('data', (c: Buffer) => { raw += c.toString() })
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }) }
          catch { resolve({ status: res.statusCode ?? 0, body: raw }) }
        })
      },
    )
    r.on('error', reject)
    if (bodyStr !== undefined) r.write(bodyStr)
    r.end()
  })
}

function tok(t: string): Record<string, string> {
  return { 'x-dashboard-token': t }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let server: ReturnType<typeof createServer>
let adminToken: string
let viewerToken: string
let noMemberToken: string

beforeAll(async () => {
  testDb = new Database(':memory:')
  testDb.pragma('journal_mode = WAL')
  makeSchema(testDb)

  // Projects
  testDb.prepare(
    `INSERT INTO projects (id, name, slug, display_name, created_at) VALUES
     ('proj-a', 'Project A', 'proj-a', 'Project A', 0),
     ('proj-b', 'Project B', 'proj-b', 'Project B', 0)`
  ).run()

  // Seed memory-v2 data
  const now = Date.now()
  const ins = testDb.prepare(
    `INSERT INTO entities (name, type, summary, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  ins.run('Entity A1', 'person', 'in proj-a', 'proj-a', now, now)
  ins.run('Entity A2', 'tool',   'in proj-a', 'proj-a', now, now)
  ins.run('Entity B1', 'person', 'in proj-b', 'proj-b', now, now)
  ins.run('Entity Unscoped', 'topic', 'shared', null, now, now)

  const obsIns = testDb.prepare(
    `INSERT INTO observations (entity_id, content, valid_from, source, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  obsIns.run(1, 'obs for a1', now, 'heuristic', 'proj-a', now)
  obsIns.run(1, 'obs for a1b', now, 'heuristic', 'proj-a', now)
  obsIns.run(3, 'obs for b1', now, 'heuristic', 'proj-b', now)

  const chatIns = testDb.prepare(
    `INSERT INTO chat_messages (chat_id, project_id, user_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  chatIns.run('chat-a', 'proj-a', null, 'user', 'hi', now)
  chatIns.run('chat-a', 'proj-a', null, 'assistant', 'hello', now)
  chatIns.run('chat-b', 'proj-b', null, 'user', 'yo', now)

  testDb.prepare(
    `INSERT INTO chat_summaries (chat_id, project_id, period_start, period_end, message_count, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('chat-a', 'proj-a', now - 1000, now, 2, 'summary of chat-a', now)

  const runIns = testDb.prepare(
    `INSERT INTO extraction_runs (run_type, project_id, started_at, finished_at, messages_processed, entities_created, observations_created, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  runIns.run('heuristic',      'proj-a', now - 3000, now - 2999, 2, 1, 2, 'completed')
  runIns.run('batch_llm',      'proj-a', now - 2000, now - 1999, 1, 0, 1, 'completed')
  runIns.run('summarization',  'proj-b', now - 1000, now - 999,  1, 0, 0, 'completed')

  initUserStore(testDb)

  // Users + tokens
  const admin = createUser({ email: 'admin@mem.test', name: 'Admin', global_role: 'admin' })
  adminToken = createUserToken({ user_id: admin.id }).token

  const viewer = createUser({ email: 'viewer@mem.test', name: 'Viewer', global_role: 'member' })
  grantProjectMembership({ project_id: 'proj-a', user_id: viewer.id, role: 'viewer' })
  viewerToken = createUserToken({ user_id: viewer.id }).token

  const noMember = createUser({ email: 'nomember@mem.test', name: 'NoMember', global_role: 'member' })
  noMemberToken = createUserToken({ user_id: noMember.id }).token

  const app = makeApp()
  ;({ server } = await startServer(app))
}, 30000)

// ===========================================================================
// GET /api/v1/memory/stats
// ===========================================================================

describe('GET /api/v1/memory/stats', () => {
  it('admin can query any project', async () => {
    const res = await httpReq(
      server,
      'GET',
      '/api/v1/memory/stats?project_id=proj-a',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as { entities: number; observations: number; chatMessages: number; chatSummaries: number }
    // proj-a entities = 2 scoped + 1 unscoped
    expect(body.entities).toBe(3)
    // proj-a observations = 2 scoped + 0 unscoped
    expect(body.observations).toBe(2)
    expect(body.chatMessages).toBe(2)
    expect(body.chatSummaries).toBe(1)
  })

  it('viewer with membership gets counts for their project', async () => {
    const res = await httpReq(
      server,
      'GET',
      '/api/v1/memory/stats?project_id=proj-a',
      { headers: tok(viewerToken) },
    )
    expect(res.status).toBe(200)
    const body = res.body as { chatMessages: number }
    expect(body.chatMessages).toBe(2)
  })

  it('viewer requesting a different project -> 404', async () => {
    const res = await httpReq(
      server,
      'GET',
      '/api/v1/memory/stats?project_id=proj-b',
      { headers: tok(viewerToken) },
    )
    expect(res.status).toBe(404)
  })

  it('member with zero memberships -> 404', async () => {
    const res = await httpReq(
      server,
      'GET',
      '/api/v1/memory/stats?project_id=proj-a',
      { headers: tok(noMemberToken) },
    )
    expect(res.status).toBe(404)
  })

  it('missing project_id -> 400', async () => {
    const res = await httpReq(
      server,
      'GET',
      '/api/v1/memory/stats',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(400)
  })

  it('no token -> 401', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/memory/stats?project_id=proj-a')
    expect(res.status).toBe(401)
  })
})

// ===========================================================================
// GET /api/v1/memory/last-extraction-run
// ===========================================================================

describe('GET /api/v1/memory/last-extraction-run', () => {
  it('admin gets the most recent run', async () => {
    const res = await httpReq(
      server,
      'GET',
      '/api/v1/memory/last-extraction-run',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const row = res.body as { run_type: string; project_id: string } | null
    expect(row).not.toBeNull()
    expect(row!.run_type).toBe('summarization')
    expect(row!.project_id).toBe('proj-b')
  })

  it('member is 403', async () => {
    const res = await httpReq(
      server,
      'GET',
      '/api/v1/memory/last-extraction-run',
      { headers: tok(viewerToken) },
    )
    expect(res.status).toBe(403)
  })
})

// ===========================================================================
// GET /api/v1/memory/recent-extraction-runs
// ===========================================================================

describe('GET /api/v1/memory/recent-extraction-runs', () => {
  it('admin gets recent runs descending', async () => {
    const res = await httpReq(
      server,
      'GET',
      '/api/v1/memory/recent-extraction-runs',
      { headers: tok(adminToken) },
    )
    expect(res.status).toBe(200)
    const rows = res.body as Array<{ run_type: string; started_at: number }>
    expect(rows.length).toBe(3)
    // descending order by started_at
    expect(rows[0].started_at).toBeGreaterThan(rows[1].started_at)
    expect(rows[1].started_at).toBeGreaterThan(rows[2].started_at)
    expect(rows[0].run_type).toBe('summarization')
  })

  it('member is 403', async () => {
    const res = await httpReq(
      server,
      'GET',
      '/api/v1/memory/recent-extraction-runs',
      { headers: tok(viewerToken) },
    )
    expect(res.status).toBe(403)
  })

  it('no token is 401', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/memory/recent-extraction-runs')
    expect(res.status).toBe(401)
  })
})
