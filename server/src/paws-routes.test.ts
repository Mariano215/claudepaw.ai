/**
 * paws-routes.test.ts
 *
 * Permission gate tests for paws-routes.ts.
 * Verifies user-scoping and role-gating on every paws endpoint.
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
import { broadcastToMac } from './ws.js'

// ---------------------------------------------------------------------------
// Mock heavy/side-effectful modules
// ---------------------------------------------------------------------------

vi.mock('./ws.js', () => ({
  broadcastToMac: vi.fn(),
  broadcastPawsUpdate: vi.fn(),
  notifyAgentMessage: vi.fn(),
  broadcastFeedUpdate: vi.fn(),
  getConnectedClients: vi.fn(() => []),
  getBotHealthSnapshots: vi.fn(() => []),
  broadcastTestUpdate: vi.fn(),
  broadcastActionItemUpdate: vi.fn(),
  broadcastActionItemChatResult: vi.fn(),
  broadcastChatResponse: vi.fn(),
  broadcastResearchChatResult: vi.fn(),
  broadcastResearchInvestigationComplete: vi.fn(),
  getBotGitHash: vi.fn(() => null),
}))

vi.mock('./system-update.js', () => ({
  getUpdateStatus: vi.fn(() => ({ status: 'up-to-date' })),
}))

vi.mock('./costs.js', () => ({
  getCostSummary: vi.fn(() => ({})),
  getLineItems: vi.fn(() => []),
  upsertLineItem: vi.fn(),
  updateLineItem: vi.fn(),
  deleteLineItem: vi.fn(),
}))

vi.mock('./action-plan-chat.js', () => ({
  getChatHistory: vi.fn(() => []),
  saveChatMessage: vi.fn(),
  makeChatMessage: vi.fn(),
  buildAgentPrompt: vi.fn(() => ''),
}))

vi.mock('./research-chat.js', () => ({
  getChatHistory: vi.fn(() => []),
  saveChatMessage: vi.fn(),
  makeChatMessage: vi.fn(),
  buildScoutContext: vi.fn(() => ''),
}))

vi.mock('./quota.js', () => ({
  quotaFetch: vi.fn(),
  QuotaCooldownError: class QuotaCooldownError extends Error {},
  getQuotaStatus: vi.fn(() => ({})),
  clearCooldown: vi.fn(),
}))

vi.mock('./integrations/routes.js', async () => {
  const { Router } = await import('express')
  const noopRouter = Router()
  return {
    mountIntegrationsRoutes: vi.fn(() => noopRouter),
  }
})

// ---------------------------------------------------------------------------
// In-memory DB
// ---------------------------------------------------------------------------

let testDb: Database.Database

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
      kind TEXT NOT NULL DEFAULT 'project',
      auto_archive_days INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS kv_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trader_pnl_snapshots (
      date TEXT PRIMARY KEY,
      account_nav REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'sourced',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS paws (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      cron TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      config TEXT NOT NULL DEFAULT '{}',
      next_run INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS paw_cycles (
      id TEXT PRIMARY KEY,
      paw_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      phase TEXT NOT NULL DEFAULT 'observe',
      state TEXT NOT NULL DEFAULT '{}',
      findings TEXT NOT NULL DEFAULT '[]',
      actions_taken TEXT NOT NULL DEFAULT '[]',
      report TEXT,
      completed_at INTEGER,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS action_audit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms         INTEGER NOT NULL,
      project_id    TEXT    NOT NULL,
      actor         TEXT    NOT NULL,
      action_class  TEXT    NOT NULL,
      decision      TEXT    NOT NULL,
      policy_value  TEXT    NOT NULL,
      ref_table     TEXT,
      ref_id        TEXT,
      payload_hash  TEXT,
      bot_row_id    INTEGER,
      synced_at     INTEGER NOT NULL DEFAULT 0
    );
  `)
}

// ---------------------------------------------------------------------------
// Mock db.js
// ---------------------------------------------------------------------------

vi.mock('./db.js', async () => {
  const getTestDb = () => testDb

  return {
    getDb: vi.fn(() => getTestDb()),
    getServerDb: vi.fn(() => getTestDb()),
    getBotDb: vi.fn(() => getTestDb()),
    getBotDbWrite: vi.fn(() => getTestDb()),
    getAllAgents: vi.fn(() => []),
    getAgent: vi.fn(() => null),
    updateAgentStatus: vi.fn(),
    upsertAgent: vi.fn(),
    deleteAgent: vi.fn(),
    sendMessage: vi.fn(),
    getMessagesForAgent: vi.fn(() => []),
    markDelivered: vi.fn(),
    markCompleted: vi.fn(),
    getRecentMessages: vi.fn(() => []),
    addFeedItem: vi.fn(),
    getRecentFeed: vi.fn(() => []),
    recordMetric: vi.fn(),
    getMetrics: vi.fn(() => []),
    upsertSecurityFinding: vi.fn(),
    getSecurityFindings: vi.fn(() => []),
    updateSecurityFindingStatus: vi.fn(),
    recordSecurityScan: vi.fn(),
    getSecurityScans: vi.fn(() => []),
    upsertSecurityScore: vi.fn(),
    getSecurityScore: vi.fn(() => null),
    getSecurityAutoFixes: vi.fn(() => []),
    recordSecurityAutoFix: vi.fn(),
    queryChatMessages: vi.fn(() => []),
    getAllScheduledTasks: vi.fn(() => []),
    getScheduledTask: vi.fn(() => null),
    updateScheduledTaskStatus: vi.fn(),
    createScheduledTask: vi.fn(),
    updateScheduledTask: vi.fn(),
    deleteScheduledTask: vi.fn(),
    getResearchItems: vi.fn(() => []),
    getResearchItem: vi.fn(() => null),
    upsertResearchItem: vi.fn(),
    updateResearchItemStatus: vi.fn(),
    updateResearchInvestigatedAt: vi.fn(),
    deleteResearchItem: vi.fn(),
    getResearchStats: vi.fn(() => ({ total: 0, by_status: {}, by_pipeline: {} })),
    getLatestBoardMeeting: vi.fn(() => null),
    getBoardMeetingHistory: vi.fn(() => []),
    getBoardMeeting: vi.fn(() => null),
    createBoardMeeting: vi.fn(),
    createBoardDecision: vi.fn(),
    getBoardDecisions: vi.fn(() => []),
    updateBoardDecisionStatus: vi.fn(),
    getBoardStats: vi.fn(() => ({ total: 0, open: 0, closed: 0 })),
    getCommsLog: vi.fn(() => []),
    getActiveConnections: vi.fn(() => []),
    getChannelLog: vi.fn(() => []),
    getAllProjectsWithSettings: vi.fn(() => []),
    getProjectById: vi.fn((id: string) => getTestDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) ?? null),
    getProjectSettingsById: vi.fn(() => null),
    createProjectInDb: vi.fn(),
    updateProjectInDb: vi.fn(),
    deleteProjectFromDb: vi.fn(),
    upsertProjectSettingsInDb: vi.fn(),
    getAllPlugins: vi.fn(() => []),
    getPluginById: vi.fn(() => null),
    updatePluginEnabled: vi.fn(),
    getAllWebhooks: vi.fn(() => []),
    createWebhookInBotDb: vi.fn(),
    deleteWebhookFromBotDb: vi.fn(),
    toggleWebhookInBotDb: vi.fn(),
    getRecentWebhookDeliveries: vi.fn(() => []),
    getProjectOverview: vi.fn(() => ({})),
    getProjectIntegrations: vi.fn(() => []),
    getAllProjectIntegrations: vi.fn(() => []),
    upsertProjectIntegration: vi.fn(),
    deleteProjectIntegration: vi.fn(),
    getMetricHealthForProject: vi.fn(() => []),
    getDegradedMetricHealth: vi.fn(() => []),
    seedProjectAgents: vi.fn(),
    setOAuthCredential: vi.fn(),
    getOAuthServiceCredentials: vi.fn(() => ({ status: 'disconnected', scopes: '' })),
    listOAuthServices: vi.fn(() => []),
    deleteOAuthService: vi.fn(),
    listProjectCredentials: vi.fn(() => []),
    listAllProjectCredentials: vi.fn(() => []),
    setProjectCredential: vi.fn(),
    deleteProjectCredentialKey: vi.fn(),
    deleteProjectCredentialService: vi.fn(),
    insertChatEvent: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// Import routes after mocks
// ---------------------------------------------------------------------------

const { default: pawsRoutes } = await import('./paws-routes.js')
const { default: routes } = await import('./routes.js')

// ---------------------------------------------------------------------------
// App factory and HTTP helpers
// ---------------------------------------------------------------------------

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', (req, res, next) => authenticate(req, res, next))
  app.use('/api/v1', (req, res, next) => scopeProjects(req, res, next))
  app.use('/api/v1', routes)
  app.use(pawsRoutes)
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let server: ReturnType<typeof createServer>

let adminToken: string
let viewerToken: string
let editorToken: string
let noMemberToken: string
let botToken: string

beforeAll(async () => {
  testDb = new Database(':memory:')
  testDb.pragma('journal_mode = WAL')
  makeSchema(testDb)

  testDb.prepare(
    `INSERT INTO projects (id, name, slug, display_name, created_at) VALUES
     ('proj-a', 'Project A', 'proj-a', 'Project A', 0),
     ('proj-b', 'Project B', 'proj-b', 'Project B', 0)`
  ).run()

  testDb.prepare(`
    INSERT INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at) VALUES
    ('paw-a1', 'proj-a', 'Paw Alpha', 'scout', '0 * * * *', 'active', '{}', 0, 0),
    ('paw-b1', 'proj-b', 'Paw Beta',  'scout', '0 * * * *', 'active', '{}', 0, 0)
  `).run()

  initUserStore(testDb)

  const admin = createUser({ email: 'admin@paws.test', name: 'Admin', global_role: 'admin' })
  adminToken = createUserToken({ user_id: admin.id }).token

  const viewer = createUser({ email: 'viewer@paws.test', name: 'Viewer', global_role: 'member' })
  grantProjectMembership({ project_id: 'proj-a', user_id: viewer.id, role: 'viewer' })
  viewerToken = createUserToken({ user_id: viewer.id }).token

  const editor = createUser({ email: 'editor@paws.test', name: 'Editor', global_role: 'member' })
  grantProjectMembership({ project_id: 'proj-a', user_id: editor.id, role: 'editor' })
  grantProjectMembership({ project_id: 'proj-b', user_id: editor.id, role: 'viewer' })
  editorToken = createUserToken({ user_id: editor.id }).token

  const noMember = createUser({ email: 'nomember@paws.test', name: 'NoMember', global_role: 'member' })
  noMemberToken = createUserToken({ user_id: noMember.id }).token

  const bot = createUser({ email: 'bot@claudepaw.local', name: 'ClaudePaw Bot', global_role: 'bot' })
  botToken = createUserToken({ user_id: bot.id }).token

  const app = makeApp()
  ;({ server } = await startServer(app))
}, 30000)

function tok(t: string): Record<string, string> {
  return { 'x-dashboard-token': t }
}

// ===========================================================================
// GET /api/v1/paws -- list scoping
// ===========================================================================

describe('GET /api/v1/paws -- project scoping', () => {
  it('member with allowed project lists only their paws', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/paws', { headers: tok(viewerToken) })
    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; paws: Array<{ project_id: string }> }
    expect(body.ok).toBe(true)
    expect(body.paws.every(p => p.project_id === 'proj-a')).toBe(true)
    expect(body.paws.length).toBeGreaterThanOrEqual(1)
  })

  it('member without explicit project_id query gets their filtered set', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/paws', { headers: tok(editorToken) })
    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; paws: Array<{ project_id: string }> }
    const ids = new Set(body.paws.map(p => p.project_id))
    expect(ids.has('proj-a')).toBe(true)
    expect(ids.has('proj-b')).toBe(true)
  })

  it('member with zero memberships sees empty list, not 500', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/paws', { headers: tok(noMemberToken) })
    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; paws: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.paws).toHaveLength(0)
  })

  it('admin sees all paws across projects', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/paws', { headers: tok(adminToken) })
    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; paws: Array<{ id: string }> }
    const ids = body.paws.map(p => p.id)
    expect(ids).toContain('paw-a1')
    expect(ids).toContain('paw-b1')
  })
})

// ===========================================================================
// GET /api/v1/paws/:id -- single read isolation
// ===========================================================================

describe('GET /api/v1/paws/:id -- cross-project isolation', () => {
  it('viewer on proj-a can read paw-a1', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/paws/paw-a1', { headers: tok(viewerToken) })
    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; paw: { id: string } }
    expect(body.ok).toBe(true)
    expect(body.paw.id).toBe('paw-a1')
  })

  it('member requesting a paw in a project they have no membership for gets 404 (hides existence)', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/paws/paw-b1', { headers: tok(viewerToken) })
    expect(res.status).toBe(404)
  })

  it('member with no memberships gets 404 for any paw (hides existence)', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/paws/paw-a1', { headers: tok(noMemberToken) })
    expect(res.status).toBe(404)
  })

  it('admin can read any paw regardless of project', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/paws/paw-b1', { headers: tok(adminToken) })
    expect(res.status).toBe(200)
  })
})

// ===========================================================================
// POST /api/v1/paws -- create gating
// ===========================================================================

describe('POST /api/v1/paws -- create gating', () => {
  it('editor creates paw in their project -> 200', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/paws', {
      headers: tok(editorToken),
      body: {
        id: 'paw-new-1',
        name: 'New Paw',
        agent_id: 'scout',
        cron: '0 */2 * * *',
        project_id: 'proj-a',
      },
    })
    expect(res.status).toBe(200)
    const body = res.body as { ok: boolean; id: string }
    expect(body.ok).toBe(true)
    expect(body.id).toBe('paw-new-1')
  })

  it('viewer trying to create a paw in their own project -> 403', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/paws', {
      headers: tok(viewerToken),
      body: {
        id: 'paw-viewer-attempt',
        name: 'Viewer Paw',
        agent_id: 'scout',
        cron: '0 */2 * * *',
        project_id: 'proj-a',
      },
    })
    expect(res.status).toBe(403)
  })

  it('member creates paw in project where they are viewer only -> 403', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/paws', {
      headers: tok(editorToken),
      body: {
        id: 'paw-cross-proj',
        name: 'Cross Paw',
        agent_id: 'scout',
        cron: '0 */2 * * *',
        project_id: 'proj-b',
      },
    })
    expect(res.status).toBe(403)
  })
})

// ===========================================================================
// Paw mutations -- cross-project isolation + role gating
// ===========================================================================

describe('Paw mutations -- cross-project isolation + role gating', () => {
  it('viewer trying to pause a paw in their own project -> 403', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/paws/paw-a1/pause', { headers: tok(viewerToken) })
    expect(res.status).toBe(403)
  })

  it('member with viewer role on paw project trying to run-now -> 403', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/paws/paw-b1/pause', { headers: tok(editorToken) })
    expect(res.status).toBe(403)
  })

  it('member with no project membership trying to mutate a paw -> 404 (hides existence)', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/paws/paw-a1/pause', { headers: tok(noMemberToken) })
    expect(res.status).toBe(404)
  })

  it('editor can pause a paw in their own project -> 200', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/paws/paw-a1/pause', { headers: tok(editorToken) })
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
    await httpReq(server, 'POST', '/api/v1/paws/paw-a1/resume', { headers: tok(editorToken) })
  })

  it('admin can mutate a paw in any project -> 200', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/paws/paw-b1/pause', { headers: tok(adminToken) })
    expect(res.status).toBe(200)
    await httpReq(server, 'POST', '/api/v1/paws/paw-b1/resume', { headers: tok(adminToken) })
  })

  it('viewer trying to run-now a paw in their own project -> 403', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/paws/paw-a1/run-now', { headers: tok(viewerToken) })
    expect(res.status).toBe(403)
  })

  it('editor cannot run-now a paw that is already waiting for approval -> 409', async () => {
    vi.mocked(broadcastToMac).mockClear()
    testDb.prepare("UPDATE paws SET status = 'waiting_approval' WHERE id = 'paw-a1'").run()
    testDb.prepare(`
      INSERT INTO paw_cycles (id, paw_id, started_at, phase, state, findings, actions_taken, completed_at, error)
      VALUES ('cycle-waiting', 'paw-a1', ?, 'decide', ?, '[]', '[]', NULL, NULL)
    `).run(Date.now(), JSON.stringify({
      observe_raw: 'raw',
      analysis: 'analysis',
      decisions: [],
      approval_requested: true,
      approval_granted: null,
      act_result: null,
    }))

    const res = await httpReq(server, 'POST', '/api/v1/paws/paw-a1/run-now', { headers: tok(editorToken) })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ ok: false, error: 'Paw is already waiting for approval' })
    expect(vi.mocked(broadcastToMac)).not.toHaveBeenCalled()

    testDb.prepare("DELETE FROM paw_cycles WHERE id = 'cycle-waiting'").run()
    testDb.prepare("UPDATE paws SET status = 'active' WHERE id = 'paw-a1'").run()
  })

  it('editor can read (GET) a paw in their project -> 200', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/paws/paw-a1', { headers: tok(editorToken) })
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
  })
})

// ===========================================================================
// POST /api/v1/internal/paws-sync -- requireBotOrAdmin gate
// ===========================================================================

describe('POST /api/v1/internal/paws-sync -- bot callback gate', () => {
  const syncBody = { paws: [], cycles: [] }

  it('member gets 403', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/internal/paws-sync', {
      headers: tok(viewerToken),
      body: syncBody,
    })
    expect(res.status).toBe(403)
    expect((res.body as { error: string }).error).toBe('bot or admin required')
  })

  it('bot passes', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/internal/paws-sync', {
      headers: tok(botToken),
      body: syncBody,
    })
    expect(res.status).toBe(200)
  })

  it('admin passes', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/internal/paws-sync', {
      headers: tok(adminToken),
      body: syncBody,
    })
    expect(res.status).toBe(200)
  })

  it('unauthenticated gets 401', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/internal/paws-sync', {
      body: syncBody,
    })
    expect(res.status).toBe(401)
  })
})

// ===========================================================================
// GET /api/v1/projects/:id/paw-state
// ===========================================================================

describe('GET /api/v1/projects/:id/paw-state', () => {
  beforeAll(() => {
    testDb.prepare(
      `INSERT INTO projects (id, name, slug, display_name, kind, created_at)
       VALUES ('trader', 'trader', 'trader', 'Paw Trader', 'paw', 0),
              ('broker', 'broker', 'broker', 'Paw Broker', 'paw', 0)`,
    ).run()
    testDb.prepare(
      `INSERT INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at)
       VALUES ('paw-trader-analyst', 'trader', 'Analyst', 'analyst', '0 8 * * *', 'active', '{}', 0, 0),
              ('re-property-scout', 'broker', 'Scout', 'broker--scout', '0 8 * * *', 'waiting_approval', '{}', 0, 0)`,
    ).run()
    testDb.prepare(
      `INSERT INTO paw_cycles (id, paw_id, started_at, phase) VALUES
       ('cyc-old', 'paw-trader-analyst', 1000, 'report'),
       ('cyc-new', 'paw-trader-analyst', 2000, 'analyze'),
       ('cyc-brk', 're-property-scout', 1500, 'decide')`,
    ).run()
    testDb.prepare(
      `INSERT INTO kv_settings (key, value) VALUES
       ('trader.progress.last', '{"mode":"paper","checked_at":2000}')`,
    ).run()
    testDb.prepare(
      `INSERT INTO trader_pnl_snapshots (date, account_nav) VALUES
       ('2026-09-08', 99000), ('2026-09-09', 101234.5)`,
    ).run()
    testDb.prepare(
      `INSERT INTO deals (id, project_id, address, status) VALUES
       ('d1', 'broker', '1 Main St', 'sourced'),
       ('d2', 'broker', '2 Main St', 'under-review'),
       ('d3', 'broker', '3 Main St', 'closed')`,
    ).run()
  })

  it('reports a plain project as not a Paw', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/projects/proj-a/paw-state', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ is_paw: false, kind: 'project', phase: null, number: null })
  })

  it('reports trader mode, latest cycle phase and NAV', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/projects/trader/paw-state', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      is_paw: true, kind: 'paw', mode: 'PAPER',
      phase: 'ANALYZE', cycle_id: 'cyc-new', number: 101234.5, label: 'NAV',
    })
  })

  it('reports WAITING for a parked broker cycle and counts open deals', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/projects/broker/paw-state', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      is_paw: true, kind: 'paw', phase: 'WAITING', number: 2, label: 'deals in pipeline',
    })
  })

  it('404s a member with no read access to the project (requireProjectRead hides existence)', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/projects/trader/paw-state', {
      headers: { 'x-dashboard-token': noMemberToken },
    })
    expect(r.status).toBe(404)
  })

  it('404s an unknown project', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/projects/nope/paw-state', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(r.status).toBe(404)
  })
})

// ===========================================================================
// GET /api/v1/projects/pawdev/paw-state -- Phase 3 Task 11 badge
// ===========================================================================

describe('paw-state for pawdev', () => {
  beforeAll(() => {
    testDb.prepare(
      `INSERT OR REPLACE INTO projects (id, name, slug, display_name, icon, status, kind, created_at)
       VALUES ('pawdev','pawdev','pawdev','Paw Dev','git-pull-request','active','paw',0)`,
    ).run()
    testDb.exec(`CREATE TABLE IF NOT EXISTS action_items (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '', proposed_by TEXT NOT NULL DEFAULT '',
      executable_by_agent INTEGER NOT NULL DEFAULT 0, external_ref TEXT,
      created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`)
    for (const [id, status] of [['p1', 'blocked'], ['p2', 'blocked'], ['p3', 'approved']]) {
      testDb.prepare(
        `INSERT OR REPLACE INTO action_items (id, project_id, title, status) VALUES (?, 'pawdev', 't', ?)`,
      ).run(id, status)
    }
  })

  it('the badge number is the count of cards waiting on the owner', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/projects/pawdev/paw-state', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ is_paw: true, label: 'PRs waiting on you', number: 2 })
  })
})

// ===========================================================================
// GET /api/v1/action-audit
// ===========================================================================

describe('GET /api/v1/action-audit', () => {
  beforeAll(() => {
    testDb.prepare(
      `INSERT INTO action_audit (ts_ms, project_id, actor, action_class, decision, policy_value)
       VALUES
       (1000, 'proj-a', 'scout', 'code.pr', 'allowed', 'auto'),
       (3000, 'proj-a', 'auditor', 'social.post', 'blocked', 'ask'),
       (2000, 'proj-b', 'scout', 'email.send', 'allowed', 'auto')`,
    ).run()
  })

  it('returns rows for the requested project, newest first', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/action-audit?project_id=proj-a', { headers: tok(adminToken) })
    expect(r.status).toBe(200)
    const rows = r.body as Array<{ ts_ms: number; project_id: string }>
    expect(rows.map(row => row.ts_ms)).toEqual([3000, 1000])
    expect(rows.every(row => row.project_id === 'proj-a')).toBe(true)
  })

  it('allows a viewer with read access to the project', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/action-audit?project_id=proj-a', { headers: tok(viewerToken) })
    expect(r.status).toBe(200)
  })

  it('404s a member with no read access to the project', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/action-audit?project_id=proj-a', { headers: tok(noMemberToken) })
    expect(r.status).toBe(404)
  })

  it('400s when project_id is missing', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/action-audit', { headers: tok(adminToken) })
    expect(r.status).toBe(400)
  })
})

describe('GET /api/v1/needs-you/count', () => {
  beforeAll(() => {
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS action_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        proposed_by TEXT NOT NULL DEFAULT '',
        executable_by_agent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS trader_decisions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        asset TEXT NOT NULL DEFAULT '',
        decided_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT 'default',
        status TEXT NOT NULL DEFAULT 'active',
        last_run INTEGER,
        last_result TEXT
      );
    `)
    const now = Date.now()
    testDb.prepare(
      `INSERT INTO action_items (id, project_id, title, status, executable_by_agent, created_at, updated_at)
       VALUES ('ai-1', 'proj-a', 'Approve the reply', 'proposed', 0, ?, ?),
              ('ai-2', 'proj-a', 'Agent can do this', 'proposed', 1, ?, ?)`,
    ).run(now, now, now, now)
    testDb.prepare(
      `INSERT INTO trader_decisions (id, status, asset, decided_at)
       VALUES ('td-1', 'committee_review', 'SPY', ?), ('td-2', 'closed', 'QQQ', ?)`,
    ).run(now, now)
    testDb.prepare(
      `INSERT INTO scheduled_tasks (id, project_id, status, last_run, last_result)
       VALUES ('t-1', 'proj-a', 'active', ?, 'Agent error: boom'),
              ('t-2', 'proj-a', 'active', ?, 'all good')`,
    ).run(now, now)
  })

  it('counts approvals, ask cards, open trader decisions and failures for an admin', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/needs-you/count', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(r.status).toBe(200)
    const body = r.body as { total: number; by_kind: Record<string, number>; rows: unknown[] }
    // one waiting_approval paw (re-property-scout), two ask cards (ai-1, ai-2:
    // F5 drops the executable_by_agent predicate, so both proposed rows count),
    // one open trader decision (td-1), one failed task (t-1)
    expect(body.by_kind.approvals).toBe(1)
    expect(body.by_kind.cards).toBe(2)
    expect(body.by_kind.trader_decisions).toBe(1)
    expect(body.by_kind.failures).toBe(1)
    expect(body.total).toBe(5)
    expect(Array.isArray(body.rows)).toBe(true)
  })

  it('does not treat a status DECISION_STATUS never writes as terminal', async () => {
    // 'filled' cannot come from order-lifecycle.ts; it must count as an open
    // decision, or a stuck row would silently drop off the Needs You badge.
    testDb.prepare(
      `INSERT INTO trader_decisions (id, status, asset, decided_at) VALUES ('td-filled', 'filled', 'GLD', ?)`,
    ).run(Date.now())
    try {
      const r = await httpReq(server, 'GET', '/api/v1/needs-you/count', {
        headers: { 'x-dashboard-token': adminToken },
      })
      expect(r.status).toBe(200)
      const body = r.body as { by_kind: Record<string, number> }
      // td-1 ('committee_review') plus td-filled ('filled')
      expect(body.by_kind.trader_decisions).toBe(2)
    } finally {
      testDb.prepare(`DELETE FROM trader_decisions WHERE id = 'td-filled'`).run()
    }
  })

  it('scopes a member to the projects they can read', async () => {
    // viewer is a member of proj-a only, so the broker approval and the
    // trader decisions drop out.
    const r = await httpReq(server, 'GET', '/api/v1/needs-you/count', {
      headers: { 'x-dashboard-token': viewerToken },
    })
    expect(r.status).toBe(200)
    const body = r.body as { by_kind: Record<string, number> }
    expect(body.by_kind.approvals).toBe(0)
    expect(body.by_kind.trader_decisions).toBe(0)
    expect(body.by_kind.cards).toBe(2)
  })

  it('counts every proposed card, not just the 50-row page returned for the list', async () => {
    const now = Date.now()
    const insert = testDb.prepare(
      `INSERT INTO action_items (id, project_id, title, status, executable_by_agent, created_at, updated_at)
       VALUES (?, 'proj-a', 'Bulk card', 'proposed', 0, ?, ?)`,
    )
    for (let i = 0; i < 58; i++) insert.run('bulk-' + i, now, now)
    // 58 new + the 2 from beforeAll = 60 proposed cards total.
    const r = await httpReq(server, 'GET', '/api/v1/needs-you/count', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(r.status).toBe(200)
    const body = r.body as { by_kind: Record<string, number>; rows: unknown[] }
    expect(body.by_kind.cards).toBe(60)
    expect(body.rows.filter((row: any) => row.kind === 'card').length).toBe(50)
  })
})

describe('GET /api/v1/needs-you', () => {
  it('scopes a member to only their project rows', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/needs-you', {
      headers: { 'x-dashboard-token': viewerToken },
    })
    expect(r.status).toBe(200)
    const body = r.body as { rows: Array<{ project_id: string }> }
    expect(body.rows.length).toBeGreaterThan(0)
    expect(body.rows.every(row => row.project_id === 'proj-a')).toBe(true)
  })

  it('gives an admin every row across projects', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/needs-you', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(r.status).toBe(200)
    const body = r.body as { rows: Array<{ project_id: string }> }
    expect(body.rows.some(row => row.project_id === 'proj-a')).toBe(true)
    expect(body.rows.some(row => row.project_id === 'trader')).toBe(true)
  })

  it('gives a member with no project access empty rows and a 200', async () => {
    const r = await httpReq(server, 'GET', '/api/v1/needs-you', {
      headers: { 'x-dashboard-token': noMemberToken },
    })
    expect(r.status).toBe(200)
    const body = r.body as { rows: unknown[] }
    expect(body.rows).toEqual([])
  })
})
