/**
 * routes-permissions.test.ts
 *
 * Targeted permission gate tests for the main API router.
 * Each scenario verifies that the middleware chain (authenticate -> scopeProjects ->
 * requireAdmin / requireProjectRead / requireProjectRole) correctly enforces access
 * control on the real Express router from routes.ts.
 *
 * Heavy side-effecting modules (ws, system-update, costs, action-plan-chat,
 * research-chat, quota, integrations/routes) are vi.mock'd to no-ops so only the
 * permission gates matter.
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
// Mock heavy/side-effectful modules
// ---------------------------------------------------------------------------

vi.mock('./ws.js', () => ({
  notifyAgentMessage: vi.fn(),
  broadcastFeedUpdate: vi.fn(),
  broadcastToMac: vi.fn(),
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

vi.mock('./integrations/routes.js', () => {
  const { Router } = require('express')
  const noopRouter = Router()
  return {
    mountIntegrationsRoutes: vi.fn(() => noopRouter),
  }
})

// ---------------------------------------------------------------------------
// In-memory DB + user store bootstrap
// ---------------------------------------------------------------------------

// We need a single shared DB/userStore because routes.ts calls db helpers at
// module level via the singleton pattern. We initialise the userStore with our
// test DB and also swap the main telemetry DB references via getDb / getBotDb.

let testDb: Database.Database

// Tokens for each persona
let adminToken: string
let memberToken: string   // viewer on proj-a only
let editorToken: string   // editor on proj-a, viewer on proj-b
let noMemberToken: string // no memberships
let botToken: string      // bot role, no project memberships

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
    CREATE TABLE IF NOT EXISTS project_settings (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      theme TEXT,
      telegram_chat_id TEXT,
      telegram_bot_token TEXT,
      telegram_bot_username TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS feed (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT,
      agent_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_run INTEGER,
      next_run INTEGER,
      last_result TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      project_id TEXT
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'chat',
      keywords TEXT NOT NULL DEFAULT '[]',
      capabilities TEXT NOT NULL DEFAULT '[]',
      system_prompt TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      provider TEXT,
      model TEXT,
      fallback_policy TEXT,
      model_tier TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      direction TEXT,
      content TEXT,
      delivered INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      metric_name TEXT NOT NULL,
      value REAL NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS security_findings (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT,
      auto_fixable INTEGER DEFAULT 0,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      remediation TEXT
    );
    CREATE TABLE IF NOT EXISTS security_scans (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      scan_type TEXT NOT NULL,
      status TEXT NOT NULL,
      findings_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS security_score (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      score REAL NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS security_auto_fixes (
      id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL,
      status TEXT NOT NULL,
      patch TEXT,
      applied_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS research_items (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      source_url TEXT,
      source_type TEXT,
      tags TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'new',
      priority TEXT NOT NULL DEFAULT 'medium',
      pipeline TEXT DEFAULT '',
      investigated_at INTEGER,
      research_item_id TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS board_meetings (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      date INTEGER NOT NULL,
      summary TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS board_decisions (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'medium',
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS comms_log (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      channel TEXT NOT NULL,
      direction TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      target_url TEXT NOT NULL,
      secret TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      response_code INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS project_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      service TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS metric_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      metric_name TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      recorded_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      service TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(project_id, service, key)
    );
    CREATE TABLE IF NOT EXISTS oauth_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      service TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(project_id, service)
    );
    CREATE TABLE IF NOT EXISTS action_items (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      priority TEXT NOT NULL DEFAULT 'medium',
      source TEXT NOT NULL DEFAULT 'manual',
      proposed_by TEXT NOT NULL DEFAULT 'dashboard',
      assigned_to TEXT,
      executable_by_agent INTEGER DEFAULT 0,
      parent_id TEXT,
      target_date INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER,
      archived_at INTEGER,
      last_run_at INTEGER,
      last_run_result TEXT,
      last_run_session TEXT
    );
    CREATE TABLE IF NOT EXISTS action_item_comments (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS action_item_events (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      event_type TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS channel_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      channel TEXT NOT NULL,
      direction TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS architecture_decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chat_events (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      session_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0
    );
  `)
}

// ---------------------------------------------------------------------------
// Mock db.js AFTER we have a testDb reference
// The mock is hoisted by vite, so we use a factory that reads testDb from
// module scope. We import the real db module for type guidance only.
// ---------------------------------------------------------------------------

vi.mock('./db.js', async () => {
  // We lazily resolve testDb from module scope -- by the time any test runs
  // the beforeAll has run and testDb is set.
  const getTestDb = () => testDb

  function getAllProjects() {
    return getTestDb().prepare('SELECT * FROM projects').all()
  }

  function getProjectById(id: string) {
    return getTestDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) ?? null
  }

  function getProjectSettingsById(id: string) {
    return getTestDb().prepare('SELECT * FROM project_settings WHERE project_id = ?').get(id) ?? null
  }

  function getAllProjectsWithSettings() {
    const projects = getAllProjects() as Array<Record<string, unknown>>
    return projects.map(p => ({ ...p, settings: getProjectSettingsById(p.id as string) }))
  }

  function createProjectInDb(data: Record<string, unknown>) {
    getTestDb().prepare(
      `INSERT INTO projects (id, name, slug, display_name, icon, status, auto_archive_days, created_at)
       VALUES (@id, @name, @slug, @display_name, @icon, @status, @auto_archive_days, @created_at)`
    ).run({ ...data, created_at: Date.now(), status: data.status ?? 'active', icon: data.icon ?? null, auto_archive_days: data.auto_archive_days ?? null })
  }

  function updateProjectInDb(id: string, _updates: unknown) {
    // no-op for tests
  }

  function deleteProjectFromDb(id: string) {
    getTestDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
    return true
  }

  function upsertProjectSettingsInDb(_pid: string, _data: unknown) { /* no-op */ }

  function getRecentFeed(_limit: number, _sinceId?: number, projectId?: string, _agentId?: string, allowedProjectIds?: string[] | null) {
    const db = getTestDb()
    if (projectId) {
      return db.prepare('SELECT * FROM feed WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
    }
    if (Array.isArray(allowedProjectIds)) {
      if (allowedProjectIds.length === 0) return []
      const ph = allowedProjectIds.map(() => '?').join(', ')
      return db.prepare(`SELECT * FROM feed WHERE project_id IN (${ph}) ORDER BY created_at DESC`).all(...allowedProjectIds)
    }
    return db.prepare('SELECT * FROM feed ORDER BY created_at DESC').all()
  }

  function getAllScheduledTasks(projectId?: string, allowedProjectIds?: string[] | null) {
    const db = getTestDb()
    if (projectId) {
      return db.prepare('SELECT * FROM scheduled_tasks WHERE project_id = ?').all(projectId)
    }
    if (Array.isArray(allowedProjectIds)) {
      if (allowedProjectIds.length === 0) return []
      const ph = allowedProjectIds.map(() => '?').join(', ')
      return db.prepare(`SELECT * FROM scheduled_tasks WHERE project_id IN (${ph})`).all(...allowedProjectIds)
    }
    return db.prepare('SELECT * FROM scheduled_tasks').all()
  }

  function getScheduledTask(id: string) {
    return getTestDb().prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) ?? null
  }

  function createScheduledTask(data: Record<string, unknown>) {
    getTestDb().prepare(
      `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, project_id, created_at, updated_at)
       VALUES (@id, @chat_id, @prompt, @schedule, @next_run, @project_id, @created_at, @updated_at)`
    ).run({ ...data, created_at: Date.now(), updated_at: Date.now() })
    return data
  }

  function getAllAgents(projectId?: string, allowedProjectIds?: string[] | null) {
    const db = getTestDb()
    if (projectId) {
      return db.prepare('SELECT * FROM agents WHERE project_id = ?').all(projectId)
    }
    if (Array.isArray(allowedProjectIds)) {
      if (allowedProjectIds.length === 0) return []
      const ph = allowedProjectIds.map(() => '?').join(', ')
      return db.prepare(`SELECT * FROM agents WHERE project_id IN (${ph})`).all(...allowedProjectIds)
    }
    return db.prepare('SELECT * FROM agents').all()
  }

  function listProjectCredentials(projectId: string) {
    const rows = getTestDb().prepare(
      'SELECT service, key, updated_at FROM credentials WHERE project_id = ?'
    ).all(projectId) as Array<{ service: string; key: string; updated_at: number }>
    const byService = new Map<string, Array<{ key: string; updated_at: number }>>()
    for (const row of rows) {
      if (!byService.has(row.service)) byService.set(row.service, [])
      byService.get(row.service)!.push({ key: row.key, updated_at: row.updated_at })
    }
    return Array.from(byService.entries()).map(([service, keys]) => ({ service, keys }))
  }

  function setProjectCredential(projectId: string, service: string, key: string, value: string) {
    getTestDb().prepare(
      `INSERT INTO credentials (project_id, service, key, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, service, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(projectId, service, key, value, Date.now())
  }

  function seedProjectAgents(_pid: string) { /* no-op */ }

  // Stubs that return empty / no-op
  const stub = <T>(v: T) => vi.fn(() => v)
  const stubNull = () => vi.fn(() => null)
  const stubArr = () => vi.fn(() => [])

  return {
    getDb: vi.fn(() => getTestDb()),
    getBotDb: vi.fn(() => getTestDb()),
    getBotDbWrite: vi.fn(() => getTestDb()),
    getAllAgents,
    getAgent: vi.fn((id: string) => getTestDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) ?? null),
    updateAgentStatus: vi.fn(),
    upsertAgent: vi.fn(),
    deleteAgent: vi.fn(),
    sendMessage: vi.fn(),
    getMessagesForAgent: stubArr(),
    markDelivered: vi.fn(),
    markCompleted: vi.fn(),
    getRecentMessages: vi.fn(() => []),
    addFeedItem: vi.fn(),
    getRecentFeed,
    recordMetric: vi.fn(),
    getMetrics: stubArr(),
    upsertSecurityFinding: vi.fn(),
    getSecurityFindings: stubArr(),
    updateSecurityFindingStatus: vi.fn(),
    recordSecurityScan: vi.fn(),
    getSecurityScans: stubArr(),
    upsertSecurityScore: vi.fn(),
    getSecurityScore: stubNull(),
    getSecurityAutoFixes: stubArr(),
    recordSecurityAutoFix: vi.fn(),
    queryChatMessages: stubArr(),
    getAllScheduledTasks,
    getScheduledTask,
    updateScheduledTaskStatus: vi.fn(),
    createScheduledTask,
    updateScheduledTask: vi.fn(),
    deleteScheduledTask: vi.fn(),
    getResearchItems: stubArr(),
    getResearchItem: vi.fn((id: string) => getTestDb().prepare('SELECT * FROM research_items WHERE id = ?').get(id) ?? null),
    upsertResearchItem: vi.fn(),
    updateResearchItemStatus: vi.fn(),
    updateResearchInvestigatedAt: vi.fn(),
    deleteResearchItem: vi.fn(),
    getResearchStats: stub({ total: 0, by_status: {}, by_pipeline: {} }),
    getLatestBoardMeeting: stubNull(),
    getBoardMeetingHistory: stubArr(),
    getBoardMeeting: stubNull(),
    createBoardMeeting: vi.fn(),
    createBoardDecision: vi.fn(),
    getBoardDecisions: stubArr(),
    updateBoardDecisionStatus: vi.fn(),
    getBoardStats: stub({ total: 0, open: 0, closed: 0 }),
    getCommsLog: stubArr(),
    getActiveConnections: stubArr(),
    getChannelLog: stubArr(),
    getAllProjectsWithSettings,
    getProjectById,
    getProjectSettingsById,
    createProjectInDb,
    updateProjectInDb,
    deleteProjectFromDb,
    upsertProjectSettingsInDb,
    getAllPlugins: stubArr(),
    getPluginById: stubNull(),
    updatePluginEnabled: vi.fn(),
    getAllWebhooks: stubArr(),
    createWebhookInBotDb: vi.fn(() => ({ id: 'wh-1', project_id: 'proj-a', event_type: 'feed.new', target_url: 'https://example.com', active: 1, created_at: 0 })),
    deleteWebhookFromBotDb: vi.fn(),
    toggleWebhookInBotDb: vi.fn(),
    getRecentWebhookDeliveries: stubArr(),
    getProjectOverview: stub({}),
    getProjectIntegrations: stubArr(),
    getAllProjectIntegrations: stubArr(),
    upsertProjectIntegration: vi.fn(),
    deleteProjectIntegration: vi.fn(),
    getMetricHealthForProject: stubArr(),
    getDegradedMetricHealth: stubArr(),
    seedProjectAgents,
    setOAuthCredential: vi.fn(),
    getOAuthServiceCredentials: stub({ status: 'disconnected', scopes: '' }),
    listOAuthServices: stubArr(),
    deleteOAuthService: vi.fn(),
    listProjectCredentials,
    listAllProjectCredentials: stubArr(),
    setProjectCredential,
    deleteProjectCredentialKey: vi.fn(),
    deleteProjectCredentialService: vi.fn(),
    insertChatEvent: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// Now import routes (after mocks are registered)
// ---------------------------------------------------------------------------

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
// Shared test server and fixtures (set up once for all suites)
// ---------------------------------------------------------------------------

let server: ReturnType<typeof createServer>
let stop: () => Promise<void>

beforeAll(async () => {
  testDb = new Database(':memory:')
  testDb.pragma('journal_mode = WAL')
  makeSchema(testDb)

  // Seed projects
  testDb.prepare(
    `INSERT INTO projects (id, name, slug, display_name, created_at) VALUES
     ('proj-a', 'Project A', 'proj-a', 'Project A', 0),
     ('proj-b', 'Project B', 'proj-b', 'Project B', 0)`
  ).run()

  // Seed feed items
  testDb.prepare(
    `INSERT INTO feed (id, project_id, type, summary, created_at) VALUES
     ('f1', 'proj-a', 'test', 'Feed A item', 0),
     ('f2', 'proj-b', 'test', 'Feed B item', 0)`
  ).run()

  // Seed one task in proj-a
  testDb.prepare(
    `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, project_id, created_at, updated_at) VALUES
     ('task-a1', '111', 'do stuff', '0 * * * *', 'proj-a', 0, 0)`
  ).run()

  // Seed research items -- one per project for cross-project read tests
  testDb.prepare(
    `INSERT INTO research_items (id, project_id, title, status, priority, created_at, updated_at) VALUES
     ('research-a1', 'proj-a', 'Research A', 'new', 'medium', 0, 0),
     ('research-b1', 'proj-b', 'Research B', 'new', 'medium', 0, 0)`
  ).run()

  initUserStore(testDb)

  // admin -- global admin, no project memberships needed
  const admin = createUser({ email: 'admin@test.com', name: 'Admin', global_role: 'admin' })
  const { token: at } = createUserToken({ user_id: admin.id })
  adminToken = at

  // member -- viewer on proj-a only
  const member = createUser({ email: 'member@test.com', name: 'Member', global_role: 'member' })
  grantProjectMembership({ project_id: 'proj-a', user_id: member.id, role: 'viewer' })
  const { token: mt } = createUserToken({ user_id: member.id })
  memberToken = mt

  // editor -- editor on proj-a, viewer on proj-b
  const editor = createUser({ email: 'editor@test.com', name: 'Editor', global_role: 'member' })
  grantProjectMembership({ project_id: 'proj-a', user_id: editor.id, role: 'editor' })
  grantProjectMembership({ project_id: 'proj-b', user_id: editor.id, role: 'viewer' })
  const { token: et } = createUserToken({ user_id: editor.id })
  editorToken = et

  // noMember -- no memberships
  const noMember = createUser({ email: 'nomember@test.com', name: 'NoMember', global_role: 'member' })
  const { token: nt } = createUserToken({ user_id: noMember.id })
  noMemberToken = nt

  // bot -- bot role, zero project memberships
  const bot = createUser({ email: 'bot@claudepaw.local', name: 'ClaudePaw Bot', global_role: 'bot' })
  const { token: bt } = createUserToken({ user_id: bot.id })
  botToken = bt

  const app = makeApp()
  ;({ server, stop } = await startServer(app))
}, 30000)

// afterAll is intentionally omitted -- vitest tears down the process anyway,
// but if needed: `afterAll(async () => stop())`

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function tok(t: string): Record<string, string> {
  return { 'x-dashboard-token': t }
}

// ===========================================================================
// 1. GET /feed -- scoped read
// ===========================================================================

describe('GET /api/v1/feed -- project scoping', () => {
  it('admin sees all feed items (no allowedProjectIds filter)', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/feed', { headers: tok(adminToken) })
    expect(res.status).toBe(200)
    const items = res.body as unknown[]
    // admin bypass -> both proj-a and proj-b items
    expect(Array.isArray(items)).toBe(true)
    expect(items.length).toBeGreaterThanOrEqual(2)
  })

  it('viewer on proj-a only sees proj-a feed', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/feed', { headers: tok(memberToken) })
    expect(res.status).toBe(200)
    const items = res.body as Array<{ project_id?: string }>
    expect(Array.isArray(items)).toBe(true)
    for (const item of items) {
      expect(item.project_id).toBe('proj-a')
    }
  })

  it('user with zero memberships sees empty feed', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/feed', { headers: tok(noMemberToken) })
    expect(res.status).toBe(200)
    const items = res.body as unknown[]
    expect(Array.isArray(items)).toBe(true)
    expect(items.length).toBe(0)
  })

  it('member filters by explicit project_id=proj-a (in their allowed list)', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/feed?project_id=proj-a', { headers: tok(memberToken) })
    expect(res.status).toBe(200)
  })

  it('member gets 404 when requesting project_id they do not belong to', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/feed?project_id=proj-b', { headers: tok(memberToken) })
    expect(res.status).toBe(404)
  })

  it('unauthenticated request is rejected 401', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/feed')
    expect(res.status).toBe(401)
  })
})

// ===========================================================================
// 2. GET /tasks -- scoped read
// ===========================================================================

describe('GET /api/v1/tasks -- project scoping', () => {
  it('admin sees all tasks', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/tasks', { headers: tok(adminToken) })
    expect(res.status).toBe(200)
    const tasks = res.body as unknown[]
    expect(Array.isArray(tasks)).toBe(true)
    expect(tasks.length).toBeGreaterThanOrEqual(1)
  })

  it('viewer on proj-a sees proj-a tasks', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/tasks', { headers: tok(memberToken) })
    expect(res.status).toBe(200)
    const tasks = res.body as Array<{ project_id?: string }>
    expect(Array.isArray(tasks)).toBe(true)
    expect(tasks.length).toBeGreaterThanOrEqual(1)
    for (const t of tasks) expect(t.project_id).toBe('proj-a')
  })

  it('zero-membership user sees no tasks', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/tasks', { headers: tok(noMemberToken) })
    expect(res.status).toBe(200)
    const tasks = res.body as unknown[]
    expect(Array.isArray(tasks)).toBe(true)
    expect(tasks.length).toBe(0)
  })
})

// ===========================================================================
// 3. POST /tasks -- mutation gating (requireProjectRole editor)
// ===========================================================================

describe('POST /api/v1/tasks -- editor gate', () => {
  it('editor on proj-a can create a task', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/tasks', {
      headers: tok(editorToken),
      body: {
        id: 'task-editor-new',
        chat_id: '222',
        prompt: 'test prompt',
        schedule: '0 9 * * *',
        project_id: 'proj-a',
      },
    })
    // Should succeed (201 or 200), not 403
    expect(res.status).not.toBe(403)
    expect(res.status).toBeLessThan(500)
  })

  it('viewer (member) on proj-a gets 403 trying to create a task in proj-a', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/tasks', {
      headers: tok(memberToken),
      body: {
        id: 'task-viewer-attempt',
        chat_id: '222',
        prompt: 'test prompt',
        schedule: '0 9 * * *',
        project_id: 'proj-a',
      },
    })
    expect(res.status).toBe(403)
  })

  it('editor on proj-a gets 403 trying to create a task in proj-b (viewer there)', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/tasks', {
      headers: tok(editorToken),
      body: {
        id: 'task-wrong-proj',
        chat_id: '222',
        prompt: 'test prompt',
        schedule: '0 9 * * *',
        project_id: 'proj-b',
      },
    })
    expect(res.status).toBe(403)
  })
})

// ===========================================================================
// 4. Admin-only routes
// ===========================================================================

describe('Admin-only route gates', () => {
  const adminOnlyRoutes: Array<[string, string, unknown?]> = [
    ['GET', '/api/v1/costs'],
    ['GET', '/api/v1/costs/line-items'],
    ['GET', '/api/v1/logging'],
    ['GET', '/api/v1/graph'],
    ['GET', '/api/v1/metric-health/degraded'],
    ['POST', '/api/v1/tests/run'],
    ['POST', '/api/v1/system/upgrade'],
    ['POST', '/api/v1/action-items/purge-stale'],
  ]

  for (const [method, path, body] of adminOnlyRoutes) {
    it(`${method} ${path}: admin passes, member gets 403`, async () => {
      const memberRes = await httpReq(server, method, path, {
        headers: tok(memberToken),
        body,
      })
      // Must be blocked -- 403 (or 400/404 for bad payload, but never 200 for member)
      expect(memberRes.status).toBe(403)

      const adminRes = await httpReq(server, method, path, {
        headers: tok(adminToken),
        body,
      })
      // Admin is not blocked by permission middleware (may still get 400/503 for bad payload)
      expect(adminRes.status).not.toBe(403)
      expect(adminRes.status).not.toBe(401)
    })
  }
})

// ===========================================================================
// 5. GET /projects/:id -- requireProjectRead
// ===========================================================================

describe('GET /api/v1/projects/:id -- requireProjectRead', () => {
  it('member can read their own project', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/projects/proj-a', { headers: tok(memberToken) })
    expect(res.status).toBe(200)
  })

  it('member gets 404 for a project they are not in', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/projects/proj-b', { headers: tok(memberToken) })
    expect(res.status).toBe(404)
  })

  it('admin can read any project', async () => {
    const resA = await httpReq(server, 'GET', '/api/v1/projects/proj-a', { headers: tok(adminToken) })
    const resB = await httpReq(server, 'GET', '/api/v1/projects/proj-b', { headers: tok(adminToken) })
    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
  })

  it('zero-membership user gets 404 for any project', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/projects/proj-a', { headers: tok(noMemberToken) })
    expect(res.status).toBe(404)
  })
})

// ===========================================================================
// 6. POST /credentials -- requireProjectRole editor
// ===========================================================================

describe('POST /api/v1/credentials -- editor gate', () => {
  it('editor on proj-a can write credentials', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/credentials', {
      headers: tok(editorToken),
      body: { project_id: 'proj-a', service: 'twitter', key: 'api_key', value: 'abc123' },
    })
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })

  it('viewer on proj-a gets 403 trying to write credentials', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/credentials', {
      headers: tok(memberToken),
      body: { project_id: 'proj-a', service: 'twitter', key: 'api_key', value: 'abc123' },
    })
    expect(res.status).toBe(403)
  })
})

// ===========================================================================
// 7. POST /projects -- requireAdmin
// ===========================================================================

describe('POST /api/v1/projects -- admin gate', () => {
  it('admin can create a project', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/projects', {
      headers: tok(adminToken),
      body: { id: 'proj-new', name: 'New', slug: 'proj-new', display_name: 'New Project' },
    })
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })

  it('member (editor on proj-a) gets 403 trying to create a project', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/projects', {
      headers: tok(editorToken),
      body: { id: 'proj-sneaky', name: 'Sneaky', slug: 'proj-sneaky', display_name: 'Sneaky' },
    })
    expect(res.status).toBe(403)
  })
})

// ===========================================================================
// 9. CRITICAL -- GET /integrations/google/access-token credential leak
// ===========================================================================

describe('GET /api/v1/integrations/google/access-token -- viewer gate', () => {
  it('member on proj-a can call access-token endpoint for proj-a', async () => {
    // Will fail with 404/500 (no real OAuth creds) but NOT 403 -- permission passes
    const res = await httpReq(server, 'GET', '/api/v1/integrations/google/access-token?project_id=proj-a&account=test@test.com', {
      headers: tok(memberToken),
    })
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })

  it('member gets 404 requesting access-token for a project they do not belong to (scopeProjects intercepts)', async () => {
    // scopeProjects fires before requireProjectRole and returns 404 (not 403)
    // to avoid leaking project existence information.
    const res = await httpReq(server, 'GET', '/api/v1/integrations/google/access-token?project_id=proj-b&account=test@test.com', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(404)
  })

  it('no-member gets 404 for any project (scopeProjects returns 404)', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/integrations/google/access-token?project_id=proj-a&account=test@test.com', {
      headers: tok(noMemberToken),
    })
    expect(res.status).toBe(404)
  })

  it('admin bypasses gate for any project', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/integrations/google/access-token?project_id=proj-b&account=test@test.com', {
      headers: tok(adminToken),
    })
    // Not blocked by permission gate (may 404/500 -- no actual OAuth config in test)
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })
})

// ===========================================================================
// 10. GET /integrations/status -- project-scoped viewer gate
// ===========================================================================

describe('GET /api/v1/integrations/status -- viewer gate', () => {
  it('member gets 404 requesting status for a project they do not belong to (scopeProjects intercepts)', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/integrations/status?project_id=proj-b', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(404)
  })

  it('member on proj-a can request status for proj-a', async () => {
    // Permission passes; may 500 due to missing CREDENTIAL_ENCRYPTION_KEY but not 403
    const res = await httpReq(server, 'GET', '/api/v1/integrations/status?project_id=proj-a', {
      headers: tok(memberToken),
    })
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })

  it('member with no project_id gets 400 (project_id required by route)', async () => {
    // requireProjectRole returns 400 when no pid can be resolved
    const res = await httpReq(server, 'GET', '/api/v1/integrations/status', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(400)
  })
})

// ===========================================================================
// 11. GET /credentials -- admin required when no project_id
// ===========================================================================

describe('GET /api/v1/credentials -- scoped gate', () => {
  it('admin can list all credentials without project_id', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/credentials', {
      headers: tok(adminToken),
    })
    expect(res.status).toBe(200)
  })

  it('member without project_id gets 403 (admin required for cross-project list)', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/credentials', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(403)
  })

  it('member can list credentials for a project they belong to', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/credentials?project_id=proj-a', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(200)
  })

  it('member gets 404 listing credentials for a project they do not belong to (scopeProjects intercepts)', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/credentials?project_id=proj-b', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(404)
  })
})

// ===========================================================================
// 12. GET /agents/config/:id -- viewer gate (cross-project read)
// ===========================================================================

describe('GET /api/v1/agents/config/:id -- viewer gate', () => {
  beforeAll(() => {
    // Seed an agent in proj-a so the lookup returns a project_id
    testDb.prepare(`
      INSERT OR IGNORE INTO agents (id, project_id, name, emoji, role, mode, created_at, updated_at)
      VALUES ('agent-a1', 'proj-a', 'Test Agent', '🤖', 'assistant', 'chat', 0, 0)
    `).run()
    // Seed an agent in proj-b
    testDb.prepare(`
      INSERT OR IGNORE INTO agents (id, project_id, name, emoji, role, mode, created_at, updated_at)
      VALUES ('agent-b1', 'proj-b', 'Test Agent B', '🤖', 'assistant', 'chat', 0, 0)
    `).run()
  })

  it('member on proj-a can read config for an agent in proj-a', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/agents/config/agent-a1', {
      headers: tok(memberToken),
    })
    // Permission passes; may 404 because no .md file exists in test env
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })

  it('member gets 404 reading config for an agent in proj-b (hides resource existence)', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/agents/config/agent-b1', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(404)
  })

  it('admin can read config for any agent', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/agents/config/agent-b1', {
      headers: tok(adminToken),
    })
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })
})

// ===========================================================================
// 13. GET /projects -- filtered by membership for non-admins
// ===========================================================================

describe('GET /api/v1/projects -- member-scoped list', () => {
  it('admin sees all projects', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/projects', { headers: tok(adminToken) })
    expect(res.status).toBe(200)
    const projects = res.body as Array<{ id: string }>
    // Both proj-a and proj-b should be visible (plus any created in other tests)
    const ids = projects.map(p => p.id)
    expect(ids).toContain('proj-a')
    expect(ids).toContain('proj-b')
  })

  it('member only sees projects they belong to', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/projects', { headers: tok(memberToken) })
    expect(res.status).toBe(200)
    const projects = res.body as Array<{ id: string }>
    const ids = projects.map(p => p.id)
    expect(ids).toContain('proj-a')
    // proj-b is NOT in member's allowed list
    expect(ids).not.toContain('proj-b')
  })

  it('zero-membership user sees empty list', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/projects', { headers: tok(noMemberToken) })
    expect(res.status).toBe(200)
    const projects = res.body as Array<{ id: string }>
    // noMember has no memberships -- empty array
    expect(projects).toHaveLength(0)
  })
})

// ===========================================================================
// 14. POST /security/trigger -- editor gate
// ===========================================================================

describe('POST /api/v1/security/trigger -- editor gate', () => {
  it('editor on proj-a can trigger a security scan', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/security/trigger', {
      headers: tok(editorToken),
      body: { scope: 'daily', project_id: 'proj-a' },
    })
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })

  it('viewer on proj-a gets 403 trying to trigger a security scan', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/security/trigger', {
      headers: tok(memberToken),
      body: { scope: 'daily', project_id: 'proj-a' },
    })
    expect(res.status).toBe(403)
  })
})

// ===========================================================================
// 15. PATCH /plugins/:id -- admin gate
// ===========================================================================

describe('PATCH /api/v1/plugins/:id -- admin gate', () => {
  it('admin can toggle a plugin', async () => {
    const res = await httpReq(server, 'PATCH', '/api/v1/plugins/some-plugin', {
      headers: tok(adminToken),
      body: { enabled: true },
    })
    // Not 403 (may be 404 -- no real plugin in test DB)
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })

  it('editor (member) gets 403 trying to toggle a plugin', async () => {
    const res = await httpReq(server, 'PATCH', '/api/v1/plugins/some-plugin', {
      headers: tok(editorToken),
      body: { enabled: true },
    })
    expect(res.status).toBe(403)
  })
})

// ===========================================================================
// 8. Unauthenticated access is always 401
// ===========================================================================

describe('Unauthenticated requests rejected on mutating endpoints', () => {
  const routes: Array<[string, string, unknown?]> = [
    ['POST', '/api/v1/tasks', { id: 'x', chat_id: '1', prompt: 'p', schedule: '0 * * * *' }],
    ['POST', '/api/v1/credentials', { project_id: 'proj-a', service: 's', key: 'k', value: 'v' }],
    ['GET', '/api/v1/costs'],
    ['POST', '/api/v1/projects', { id: 'x', name: 'x', slug: 'x', display_name: 'x' }],
  ]

  for (const [method, path, body] of routes) {
    it(`${method} ${path} without token -> 401`, async () => {
      const res = await httpReq(server, method, path, { body })
      expect(res.status).toBe(401)
    })
  }
})

// ===========================================================================
// BLOCKER 1: GET /messages?agent=X -- cross-project agent bypass
// ===========================================================================

describe('GET /api/v1/messages?agent -- cross-project scope', () => {
  // Agents are seeded in the agents/config/:id describe block -- but we need
  // them available here too. Use the globally seeded agents (agent-a1 in proj-a,
  // agent-b1 in proj-b) which are inserted in their own beforeAll.
  // Those beforeAlls run before these tests because describe blocks share the
  // same beforeAll order within the module.

  it('member on proj-a can read messages for an agent in proj-a', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/messages?agent=agent-a1', {
      headers: tok(memberToken),
    })
    // Permission passes -- 200 (empty array is fine, no real messages)
    expect(res.status).toBe(200)
  })

  it('member gets 404 for messages belonging to an agent in proj-b', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/messages?agent=agent-b1', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(404)
  })

  it('member gets 404 for a completely unknown agent id', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/messages?agent=agent-nonexistent', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(404)
  })

  it('admin can read messages for any agent regardless of project', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/messages?agent=agent-b1', {
      headers: tok(adminToken),
    })
    expect(res.status).toBe(200)
  })
})

// ===========================================================================
// BLOCKER 2: requireProjectRoleForResource -- 404 on missing resource, not 400
// ===========================================================================

describe('requireProjectRoleForResource -- missing resource returns 404', () => {
  it('PATCH /agents/:id with bogus id returns 404, not 400', async () => {
    const res = await httpReq(server, 'PATCH', '/api/v1/agents/nonexistent-agent', {
      headers: tok(editorToken),
      body: { status: 'active' },
    })
    expect(res.status).toBe(404)
  })

  it('PATCH /research/:id with bogus id returns 404, not 400', async () => {
    const res = await httpReq(server, 'PATCH', '/api/v1/research/nonexistent-item', {
      headers: tok(editorToken),
      body: { status: 'reviewed' },
    })
    expect(res.status).toBe(404)
  })

  it('GET /tasks/:id with bogus id returns 404, not 400', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/tasks/nonexistent-task', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(404)
  })
})

// ===========================================================================
// CROSS-PROJECT GET :id -- single resource reads return 404 for non-members
// ===========================================================================

describe('GET /api/v1/agents/:id -- cross-project read', () => {
  it('member on proj-a can read an agent in proj-a', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/agents/agent-a1', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(200)
  })

  it('member gets 404 reading an agent in proj-b (hides resource existence)', async () => {
    // requireProjectRoleForResource returns 404 when the user is not a member
    // of the resource's project, to avoid leaking existence to outsiders.
    const res = await httpReq(server, 'GET', '/api/v1/agents/agent-b1', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/v1/tasks/:id -- cross-project read', () => {
  it('member on proj-a can read a task in proj-a', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/tasks/task-a1', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(200)
  })

  it('member gets 404 reading a task in proj-b (hides resource existence)', async () => {
    testDb.prepare(
      `INSERT OR IGNORE INTO scheduled_tasks (id, chat_id, prompt, schedule, project_id, created_at, updated_at)
       VALUES ('task-b1', '222', 'proj-b task', '0 * * * *', 'proj-b', 0, 0)`
    ).run()
    const res = await httpReq(server, 'GET', '/api/v1/tasks/task-b1', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(404)
  })
})

describe('GET /api/v1/research/:id -- cross-project read', () => {
  it('member on proj-a can read a research item in proj-a', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/research/research-a1', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(200)
  })

  it('member gets 404 reading a research item in proj-b (hides resource existence)', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/research/research-b1', {
      headers: tok(memberToken),
    })
    expect(res.status).toBe(404)
  })
})

// ===========================================================================
// 12. Bot callback endpoint gates (requireBotOrAdmin)
// ===========================================================================

describe('Bot callback endpoints -- requireBotOrAdmin gate', () => {
  it('POST /api/v1/chat/response: member gets 403', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/chat/response', {
      headers: tok(memberToken),
      body: { event_id: 'e1', result_text: 'hello' },
    })
    expect(res.status).toBe(403)
    expect((res.body as { error: string }).error).toBe('bot or admin required')
  })

  it('POST /api/v1/chat/response: bot passes', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/chat/response', {
      headers: tok(botToken),
      body: { event_id: 'e-bot-1', result_text: 'from bot' },
    })
    // 201 means gate passed (DB write succeeded)
    expect(res.status).toBe(201)
  })

  it('POST /api/v1/chat/response: admin passes', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/chat/response', {
      headers: tok(adminToken),
      body: { event_id: 'e-admin-1', result_text: 'from admin' },
    })
    expect(res.status).toBe(201)
  })

  it('POST /api/v1/chat/events: member gets 403', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/chat/events', {
      headers: tok(memberToken),
      body: { event_id: 'ev1' },
    })
    expect(res.status).toBe(403)
  })

  it('POST /api/v1/chat/events: bot passes', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/chat/events', {
      headers: tok(botToken),
      body: { event_id: 'ev-bot-1' },
    })
    expect(res.status).toBe(201)
  })

  it('POST /api/v1/research/research-a1/chat/result: member gets 403', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/research/research-a1/chat/result', {
      headers: tok(memberToken),
      body: { agent_text: 'injected', project_id: 'proj-a' },
    })
    expect(res.status).toBe(403)
  })

  it('POST /api/v1/research/research-a1/chat/result: bot passes', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/research/research-a1/chat/result', {
      headers: tok(botToken),
      body: { agent_text: 'bot result', project_id: 'proj-a' },
    })
    expect(res.status).toBe(201)
  })

  it('POST /api/v1/research/research-a1/investigate/result: member gets 403', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/research/research-a1/investigate/result', {
      headers: tok(memberToken),
      body: { agent_text: 'injected', project_id: 'proj-a' },
    })
    expect(res.status).toBe(403)
  })

  it('POST /api/v1/research/research-a1/investigate/result: bot passes', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/research/research-a1/investigate/result', {
      headers: tok(botToken),
      body: { agent_text: 'bot investigation', project_id: 'proj-a' },
    })
    // 201 or 404 (if research item not found in mock db) -- either way, 403 is not returned
    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
  })
})
