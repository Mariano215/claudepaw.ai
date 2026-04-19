/**
 * system-state-routes.test.ts
 *
 * Permission gate and response-shape tests for the kill-switch CRUD endpoints.
 *
 * Assertions per spec:
 *  1. GET /api/v1/system-state/kill-switch  authed member  -> 200 { active: false } when not set
 *  2. GET after server-side setKillSwitch('test','admin')  -> 200 { active: true, reason: 'test' }
 *  3. POST with member token                               -> 403
 *  4. POST with admin token + { reason: 'spike' }         -> 200 { active: true }
 *  5. DELETE with admin token                             -> 200 { active: false }
 *  6. POST with empty reason                              -> 400
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import express from 'express'
import { createServer } from 'node:http'
import { request as nodeRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import {
  initUserStore,
  createUser,
  createUserToken,
} from './users.js'
import { authenticate, scopeProjects } from './auth.js'

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
// Mock system-state so tests control kill-switch state directly
// ---------------------------------------------------------------------------

let _ks: { set_at: number; reason: string; set_by: string | null } | null = null

vi.mock('./system-state.js', () => ({
  getKillSwitch: vi.fn(() => _ks),
  setKillSwitch: vi.fn((reason: string, setBy: string) => {
    _ks = { set_at: Date.now(), reason, set_by: setBy }
  }),
  clearKillSwitch: vi.fn(() => {
    _ks = null
  }),
}))

// ---------------------------------------------------------------------------
// In-memory DB + db.js mock
// ---------------------------------------------------------------------------

let testDb: Database.Database

function makeSchema(db: Database.Database) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      global_role TEXT NOT NULL DEFAULT 'member' CHECK(global_role IN ('admin','member','bot')),
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    )
  `).run()
  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    )
  `).run()
  db.prepare(`
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
      granted_by_user_id INTEGER,
      granted_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, user_id)
    )
  `).run()
  db.prepare(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      slug TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      icon TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      auto_archive_days INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0
    )
  `).run()
}

vi.mock('./db.js', async () => {
  const getTestDb = () => testDb

  return {
    getDb: vi.fn(() => getTestDb()),
    getBotDb: vi.fn(() => getTestDb()),
    getBotDbWrite: vi.fn(() => getTestDb()),
    getServerDb: vi.fn(() => getTestDb()),
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

const { default: systemStateRoutes } = await import('./system-state-routes.js')
const { setKillSwitch: mockSetKillSwitch } = await import('./system-state.js')

// ---------------------------------------------------------------------------
// App factory and HTTP helpers
// ---------------------------------------------------------------------------

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', (req, res, next) => authenticate(req, res, next))
  app.use('/api/v1', (req, res, next) => scopeProjects(req, res, next))
  app.use('/api/v1/system-state', systemStateRoutes)
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

let srv: ReturnType<typeof createServer>
let adminToken: string
let memberToken: string
let botToken: string

beforeAll(async () => {
  testDb = new Database(':memory:')
  testDb.pragma('journal_mode = WAL')
  makeSchema(testDb)

  initUserStore(testDb)

  const admin = createUser({ email: 'admin@ks.test', name: 'Admin', global_role: 'admin' })
  adminToken = createUserToken({ user_id: admin.id }).token

  const member = createUser({ email: 'member@ks.test', name: 'Member', global_role: 'member' })
  memberToken = createUserToken({ user_id: member.id }).token

  const bot = createUser({ email: 'bot@claudepaw.local', name: 'ClaudePaw Bot', global_role: 'bot' })
  botToken = createUserToken({ user_id: bot.id }).token

  const app = makeApp()
  ;({ server: srv } = await startServer(app))

  // Ensure clean state
  _ks = null
}, 30000)

function tok(t: string): Record<string, string> {
  return { 'x-dashboard-token': t }
}

// ===========================================================================
// Tests
// ===========================================================================

describe('GET /api/v1/system-state/kill-switch', () => {
  it('authed member gets 200 { active: false } when not set', async () => {
    _ks = null
    const res = await httpReq(srv, 'GET', '/api/v1/system-state/kill-switch', { headers: tok(memberToken) })
    expect(res.status).toBe(200)
    expect((res.body as { active: boolean }).active).toBe(false)
  })

  it('returns { active: true, reason } after kill-switch is set server-side', async () => {
    _ks = { set_at: Date.now(), reason: 'test', set_by: 'admin' }
    const res = await httpReq(srv, 'GET', '/api/v1/system-state/kill-switch', { headers: tok(memberToken) })
    expect(res.status).toBe(200)
    const body = res.body as { active: boolean; reason: string; set_at: number; set_by: string }
    expect(body.active).toBe(true)
    expect(body.reason).toBe('test')
    expect(typeof body.set_at).toBe('number')
    _ks = null
  })
})

describe('POST /api/v1/system-state/kill-switch', () => {
  it('member token gets 403', async () => {
    const res = await httpReq(srv, 'POST', '/api/v1/system-state/kill-switch', {
      headers: tok(memberToken),
      body: { reason: 'spike' },
    })
    expect(res.status).toBe(403)
  })

  it('bot token gets 403 (admin-only, not bot)', async () => {
    const res = await httpReq(srv, 'POST', '/api/v1/system-state/kill-switch', {
      headers: tok(botToken),
      body: { reason: 'spike' },
    })
    expect(res.status).toBe(403)
  })

  it('admin token + { reason: "spike" } -> 200 { active: true }', async () => {
    _ks = null
    const res = await httpReq(srv, 'POST', '/api/v1/system-state/kill-switch', {
      headers: tok(adminToken),
      body: { reason: 'spike' },
    })
    expect(res.status).toBe(200)
    const body = res.body as { active: boolean; reason: string }
    expect(body.active).toBe(true)
    expect(body.reason).toBe('spike')
    _ks = null
  })

  it('empty reason -> 400', async () => {
    const res = await httpReq(srv, 'POST', '/api/v1/system-state/kill-switch', {
      headers: tok(adminToken),
      body: { reason: '   ' },
    })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/v1/system-state/kill-switch', () => {
  it('admin token -> 200 { active: false }', async () => {
    _ks = { set_at: Date.now(), reason: 'pre-set', set_by: 'admin' }
    const res = await httpReq(srv, 'DELETE', '/api/v1/system-state/kill-switch', {
      headers: tok(adminToken),
    })
    expect(res.status).toBe(200)
    expect((res.body as { active: boolean }).active).toBe(false)
  })
})

describe('POST /api/v1/system-state/kill-switch -- uninitialized store', () => {
  afterEach(() => {
    vi.mocked(mockSetKillSwitch).mockRestore()
  })

  it('returns 500 with kill-switch store not initialized when setKillSwitch throws', async () => {
    vi.mocked(mockSetKillSwitch).mockImplementationOnce(() => {
      throw new Error('no system_state row found - DB not initialized')
    })
    const res = await httpReq(srv, 'POST', '/api/v1/system-state/kill-switch', {
      headers: tok(adminToken),
      body: { reason: 'trigger-error' },
    })
    expect(res.status).toBe(500)
    expect((res.body as { error: string }).error).toMatch(/kill-switch store not initialized/i)
  })
})
