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
      auto_archive_days INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0
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
  `)
}

// ---------------------------------------------------------------------------
// Mock db.js
// ---------------------------------------------------------------------------

vi.mock('./db.js', async () => {
  const getTestDb = () => testDb

  return {
    getDb: vi.fn(() => getTestDb()),
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
