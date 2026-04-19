import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import express from 'express'
import { createServer } from 'node:http'
import { request as nodeRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import {
  initUserStore,
  createUser,
  createUserToken,
  revokeUserToken,
  grantProjectMembership,
} from './users.js'
import {
  authenticate,
  scopeProjects,
  requireAdmin,
  requireBotOrAdmin,
  requireProjectRead,
  requireProjectRole,
  mountAuthRoutes,
  ensureAuthBootstrap,
} from './auth.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Fresh in-memory DB with users/tokens/memberships/projects schema. */
function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
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
      name TEXT NOT NULL DEFAULT ''
    );
  `)
  return db
}

/** Build a minimal Express app wired with auth + test route fixtures. */
function makeApp(db: Database.Database): express.Express {
  initUserStore(db)
  const app = express()
  app.use(express.json())
  mountAuthRoutes(app)
  app.use('/api/v1', authenticate)
  app.use('/api/v1', scopeProjects)
  app.get('/api/v1/ping', (_req, res) => res.json({ ok: true }))
  app.get('/api/v1/admin-only', requireAdmin, (_req, res) => res.json({ ok: true }))
  app.post('/api/v1/bot-or-admin', requireBotOrAdmin, (_req, res) => res.json({ ok: true }))
  app.get('/api/v1/project/:id/read', requireProjectRead('id'), (_req, res) => res.json({ ok: true }))
  app.get('/api/v1/project/:id/editor', requireProjectRole('editor'), (_req, res) => res.json({ ok: true }))
  // Route without :id param to trigger missing-pid 400
  app.get('/api/v1/no-pid/editor', requireProjectRole('editor'), (_req, res) => res.json({ ok: true }))
  return app
}

type ServerHandle = {
  server: ReturnType<typeof createServer>
  stop: () => Promise<void>
}

function startServer(app: express.Express): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const s = createServer(app)
    s.listen(0, '127.0.0.1', () => {
      resolve({ server: s, stop: () => new Promise(res => s.close(() => res())) })
    })
    s.on('error', reject)
  })
}

type ReqResult = { status: number; body: unknown; headers: Record<string, string> }

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
          const resHeaders: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) {
            resHeaders[k] = Array.isArray(v) ? v.join(', ') : (v ?? '')
          }
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw), headers: resHeaders })
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw, headers: resHeaders })
          }
        })
      },
    )
    r.on('error', reject)
    if (bodyStr !== undefined) r.write(bodyStr)
    r.end()
  })
}

// ---------------------------------------------------------------------------
// ensureAuthBootstrap
// ---------------------------------------------------------------------------

describe('ensureAuthBootstrap', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('no-op when users already exist', () => {
    const db = makeDb()
    initUserStore(db)
    createUser({ email: 'existing@test.com', name: 'Existing', global_role: 'admin' })
    vi.stubEnv('DASHBOARD_API_TOKEN', 'some-token')
    ensureAuthBootstrap(db)
    const n = (db.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }).n
    expect(n).toBe(1)
  })

  it('no-op when no users and no token env var', () => {
    const db = makeDb()
    initUserStore(db)
    vi.stubEnv('DASHBOARD_API_TOKEN', '')
    ensureAuthBootstrap(db)
    const n = (db.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }).n
    expect(n).toBe(0)
  })

  it('creates admin user + token row when no users + token set', () => {
    const db = makeDb()
    initUserStore(db)
    vi.stubEnv('DASHBOARD_API_TOKEN', 'mybootstraptoken')
    ensureAuthBootstrap(db)
    const users = db.prepare('SELECT * FROM users').all() as Array<{ global_role: string }>
    expect(users).toHaveLength(1)
    expect(users[0].global_role).toBe('admin')
    const tokens = db.prepare('SELECT * FROM user_tokens').all() as Array<{ label: string }>
    expect(tokens).toHaveLength(1)
    expect(tokens[0].label).toBe('bootstrap from DASHBOARD_API_TOKEN')
  })

  it('stores SHA-256 hash of token, not plaintext', () => {
    const db = makeDb()
    initUserStore(db)
    vi.stubEnv('DASHBOARD_API_TOKEN', 'plaintexttoken')
    ensureAuthBootstrap(db)
    const row = db.prepare('SELECT token_hash FROM user_tokens LIMIT 1').get() as { token_hash: string }
    expect(row.token_hash).not.toBe('plaintexttoken')
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses BOOTSTRAP_ADMIN_EMAIL/NAME overrides', () => {
    const db = makeDb()
    initUserStore(db)
    vi.stubEnv('DASHBOARD_API_TOKEN', 'tok')
    vi.stubEnv('BOOTSTRAP_ADMIN_EMAIL', 'custom@host.io')
    vi.stubEnv('BOOTSTRAP_ADMIN_NAME', 'Custom Admin')
    ensureAuthBootstrap(db)
    const user = db.prepare('SELECT * FROM users LIMIT 1').get() as { email: string; name: string }
    expect(user.email).toBe('custom@host.io')
    expect(user.name).toBe('Custom Admin')
  })

  it('grants owner on every existing project', () => {
    const db = makeDb()
    db.prepare(`INSERT INTO projects (id, name) VALUES ('proj-a','A'),('proj-b','B')`).run()
    initUserStore(db)
    vi.stubEnv('DASHBOARD_API_TOKEN', 'tok')
    ensureAuthBootstrap(db)
    const rows = db.prepare('SELECT project_id, role FROM project_members').all() as Array<{ project_id: string; role: string }>
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.role).toBe('owner')
  })

  it('idempotent -- second call is no-op', () => {
    const db = makeDb()
    initUserStore(db)
    vi.stubEnv('DASHBOARD_API_TOKEN', 'tok')
    ensureAuthBootstrap(db)
    ensureAuthBootstrap(db)
    const n = (db.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }).n
    expect(n).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/auth/login
// ---------------------------------------------------------------------------

describe('POST /api/v1/auth/login', () => {
  let stop: () => Promise<void>
  let server: ReturnType<typeof createServer>
  let rawToken: string
  let db: Database.Database

  beforeEach(async () => {
    db = makeDb()
    const app = makeApp(db)
    const admin = createUser({ email: 'admin@test.com', name: 'Admin', global_role: 'admin' })
    const { token } = createUserToken({ user_id: admin.id, label: 'test' })
    rawToken = token
    ;({ server, stop } = await startServer(app))
  })
  afterEach(async () => { await stop() })

  it('200 + user payload + sets HttpOnly cookie on valid token', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/auth/login', { body: { token: rawToken } })
    expect(res.status).toBe(200)
    const body = res.body as { user: { email: string; global_role: string } }
    expect(body.user.email).toBe('admin@test.com')
    expect(body.user.global_role).toBe('admin')
    expect(res.headers['set-cookie']).toContain('dashboard_api_token')
    expect(res.headers['set-cookie']).toContain('HttpOnly')
  })

  it('401 on invalid token', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/auth/login', { body: { token: 'badtoken' } })
    expect(res.status).toBe(401)
    expect((res.body as { error: string }).error).toBe('Unauthorized')
  })

  it('400 when token field is missing', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/auth/login', { body: {} })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('token is required')
  })

  it('400 when token is empty string', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/auth/login', { body: { token: '' } })
    expect(res.status).toBe(400)
  })

  it('401 on revoked token', async () => {
    const row = db.prepare('SELECT id FROM user_tokens LIMIT 1').get() as { id: number }
    revokeUserToken(row.id)
    const res = await httpReq(server, 'POST', '/api/v1/auth/login', { body: { token: rawToken } })
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// authenticate middleware
// ---------------------------------------------------------------------------

describe('authenticate middleware', () => {
  let stop: () => Promise<void>
  let server: ReturnType<typeof createServer>
  let rawToken: string
  let db: Database.Database

  beforeEach(async () => {
    db = makeDb()
    const app = makeApp(db)
    const admin = createUser({ email: 'a@test.com', name: 'A', global_role: 'admin' })
    const { token } = createUserToken({ user_id: admin.id })
    rawToken = token
    ;({ server, stop } = await startServer(app))
  })
  afterEach(async () => { await stop() })

  it('passes with valid x-dashboard-token header', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/ping', {
      headers: { 'x-dashboard-token': rawToken },
    })
    expect(res.status).toBe(200)
  })

  it('passes with valid cookie', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/ping', {
      headers: { cookie: `dashboard_api_token=${rawToken}` },
    })
    expect(res.status).toBe(200)
  })

  it('header takes precedence -- valid header + bad cookie passes', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/ping', {
      headers: { 'x-dashboard-token': rawToken, cookie: 'dashboard_api_token=badtoken' },
    })
    expect(res.status).toBe(200)
  })

  it('401 with no token', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/ping')
    expect(res.status).toBe(401)
    expect((res.body as { error: string }).error).toBe('Unauthorized')
  })

  it('401 on revoked token', async () => {
    const row = db.prepare('SELECT id FROM user_tokens LIMIT 1').get() as { id: number }
    revokeUserToken(row.id)
    const res = await httpReq(server, 'GET', '/api/v1/ping', {
      headers: { 'x-dashboard-token': rawToken },
    })
    expect(res.status).toBe(401)
  })

  it('injects synthetic admin when ALLOW_UNAUTHENTICATED_DASHBOARD=1 in dev', async () => {
    vi.stubEnv('ALLOW_UNAUTHENTICATED_DASHBOARD', '1')
    vi.stubEnv('NODE_ENV', 'development')
    const db2 = makeDb()
    const app2 = makeApp(db2)
    const { server: s2, stop: stop2 } = await startServer(app2)
    const res = await httpReq(s2, 'GET', '/api/v1/ping')
    expect(res.status).toBe(200)
    await stop2()
    vi.unstubAllEnvs()
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/auth/logout
// ---------------------------------------------------------------------------

describe('POST /api/v1/auth/logout', () => {
  let stop: () => Promise<void>
  let server: ReturnType<typeof createServer>
  let rawToken: string

  beforeEach(async () => {
    const db = makeDb()
    const app = makeApp(db)
    const admin = createUser({ email: 'a@test.com', name: 'A', global_role: 'admin' })
    const { token } = createUserToken({ user_id: admin.id })
    rawToken = token
    ;({ server, stop } = await startServer(app))
  })
  afterEach(async () => { await stop() })

  it('clears cookie and returns {} when authenticated', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/auth/logout', {
      headers: { 'x-dashboard-token': rawToken },
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({})
    expect(res.headers['set-cookie']).toContain('dashboard_api_token=;')
  })

  it('401 when not authenticated', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/auth/logout')
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/auth/me
// ---------------------------------------------------------------------------

describe('GET /api/v1/auth/me', () => {
  let stop: () => Promise<void>
  let server: ReturnType<typeof createServer>
  let rawToken: string

  beforeEach(async () => {
    const db = makeDb()
    db.prepare(`INSERT INTO projects (id, name) VALUES ('proj-x','X')`).run()
    const app = makeApp(db)
    const admin = createUser({ email: 'me@test.com', name: 'Me', global_role: 'admin' })
    grantProjectMembership({ project_id: 'proj-x', user_id: admin.id, role: 'owner' })
    const { token } = createUserToken({ user_id: admin.id })
    rawToken = token
    ;({ server, stop } = await startServer(app))
  })
  afterEach(async () => { await stop() })

  it('returns user + memberships array', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/auth/me', {
      headers: { 'x-dashboard-token': rawToken },
    })
    expect(res.status).toBe(200)
    const body = res.body as {
      user: { email: string }
      memberships: Array<{ project_id: string; role: string }>
    }
    expect(body.user.email).toBe('me@test.com')
    expect(body.memberships).toHaveLength(1)
    expect(body.memberships[0].project_id).toBe('proj-x')
    expect(body.memberships[0].role).toBe('owner')
  })

  it('401 without auth', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/auth/me')
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// scopeProjects middleware
// ---------------------------------------------------------------------------

describe('scopeProjects middleware', () => {
  let stop: () => Promise<void>
  let server: ReturnType<typeof createServer>
  let adminToken: string
  let memberToken: string

  beforeEach(async () => {
    const db = makeDb()
    db.prepare(`INSERT INTO projects (id, name) VALUES ('allowed','A'),('blocked','B')`).run()
    const app = makeApp(db)
    const admin = createUser({ email: 'adm@test.com', name: 'Adm', global_role: 'admin' })
    const { token: at } = createUserToken({ user_id: admin.id })
    adminToken = at
    const member = createUser({ email: 'mem@test.com', name: 'Mem', global_role: 'member' })
    grantProjectMembership({ project_id: 'allowed', user_id: member.id, role: 'viewer' })
    const { token: mt } = createUserToken({ user_id: member.id })
    memberToken = mt
    ;({ server, stop } = await startServer(app))
  })
  afterEach(async () => { await stop() })

  it('admin with any project_id passes', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/ping?project_id=blocked', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(res.status).toBe(200)
  })

  it('member with allowed project_id passes', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/ping?project_id=allowed', {
      headers: { 'x-dashboard-token': memberToken },
    })
    expect(res.status).toBe(200)
  })

  it('member with disallowed project_id gets 404, not 403', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/ping?project_id=blocked', {
      headers: { 'x-dashboard-token': memberToken },
    })
    expect(res.status).toBe(404)
    // Error body must not leak the project_id
    expect(JSON.stringify(res.body)).not.toContain('blocked')
  })

  it('member with no project_id passes', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/ping', {
      headers: { 'x-dashboard-token': memberToken },
    })
    expect(res.status).toBe(200)
  })

  it('project_id=all treated as no filter for admin', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/ping?project_id=all', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// requireAdmin
// ---------------------------------------------------------------------------

describe('requireAdmin middleware', () => {
  let stop: () => Promise<void>
  let server: ReturnType<typeof createServer>
  let adminToken: string
  let memberToken: string

  beforeEach(async () => {
    const db = makeDb()
    const app = makeApp(db)
    const admin = createUser({ email: 'adm@test.com', name: 'Adm', global_role: 'admin' })
    const { token: at } = createUserToken({ user_id: admin.id })
    adminToken = at
    const member = createUser({ email: 'mem@test.com', name: 'Mem', global_role: 'member' })
    const { token: mt } = createUserToken({ user_id: member.id })
    memberToken = mt
    ;({ server, stop } = await startServer(app))
  })
  afterEach(async () => { await stop() })

  it('admin passes', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/admin-only', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(res.status).toBe(200)
  })

  it('member gets 403', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/admin-only', {
      headers: { 'x-dashboard-token': memberToken },
    })
    expect(res.status).toBe(403)
    expect((res.body as { error: string }).error).toBe('Admin required')
  })
})

// ---------------------------------------------------------------------------
// requireProjectRead
// ---------------------------------------------------------------------------

describe('requireProjectRead middleware', () => {
  let stop: () => Promise<void>
  let server: ReturnType<typeof createServer>
  let adminToken: string
  let memberToken: string

  beforeEach(async () => {
    const db = makeDb()
    db.prepare(`INSERT INTO projects (id, name) VALUES ('pa','A'),('pb','B')`).run()
    const app = makeApp(db)
    const admin = createUser({ email: 'adm@test.com', name: 'Adm', global_role: 'admin' })
    const { token: at } = createUserToken({ user_id: admin.id })
    adminToken = at
    const member = createUser({ email: 'mem@test.com', name: 'Mem', global_role: 'member' })
    grantProjectMembership({ project_id: 'pa', user_id: member.id, role: 'viewer' })
    const { token: mt } = createUserToken({ user_id: member.id })
    memberToken = mt
    ;({ server, stop } = await startServer(app))
  })
  afterEach(async () => { await stop() })

  it('admin bypasses', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/project/pb/read', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(res.status).toBe(200)
  })

  it('member with membership passes', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/project/pa/read', {
      headers: { 'x-dashboard-token': memberToken },
    })
    expect(res.status).toBe(200)
  })

  it('member without membership gets 404', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/project/pb/read', {
      headers: { 'x-dashboard-token': memberToken },
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// requireProjectRole
// ---------------------------------------------------------------------------

describe('requireProjectRole middleware', () => {
  let stop: () => Promise<void>
  let server: ReturnType<typeof createServer>
  let adminToken: string
  let editorToken: string
  let viewerToken: string
  let nonMemberToken: string

  beforeEach(async () => {
    const db = makeDb()
    db.prepare(`INSERT INTO projects (id, name) VALUES ('pr','R')`).run()
    const app = makeApp(db)
    const admin = createUser({ email: 'adm@test.com', name: 'Adm', global_role: 'admin' })
    const { token: at } = createUserToken({ user_id: admin.id })
    adminToken = at
    const editor = createUser({ email: 'ed@test.com', name: 'Ed', global_role: 'member' })
    grantProjectMembership({ project_id: 'pr', user_id: editor.id, role: 'editor' })
    const { token: et } = createUserToken({ user_id: editor.id })
    editorToken = et
    const viewer = createUser({ email: 'vw@test.com', name: 'Vw', global_role: 'member' })
    grantProjectMembership({ project_id: 'pr', user_id: viewer.id, role: 'viewer' })
    const { token: vt } = createUserToken({ user_id: viewer.id })
    viewerToken = vt
    const nm = createUser({ email: 'nm@test.com', name: 'NM', global_role: 'member' })
    const { token: nt } = createUserToken({ user_id: nm.id })
    nonMemberToken = nt
    ;({ server, stop } = await startServer(app))
  })
  afterEach(async () => { await stop() })

  it('admin bypasses', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/project/pr/editor', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(res.status).toBe(200)
  })

  it('editor asking for editor role passes', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/project/pr/editor', {
      headers: { 'x-dashboard-token': editorToken },
    })
    expect(res.status).toBe(200)
  })

  it('viewer asking for editor role gets 403', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/project/pr/editor', {
      headers: { 'x-dashboard-token': viewerToken },
    })
    expect(res.status).toBe(403)
  })

  it('non-member gets 403', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/project/pr/editor', {
      headers: { 'x-dashboard-token': nonMemberToken },
    })
    expect(res.status).toBe(403)
  })

  it('missing pid returns 400', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/no-pid/editor', {
      headers: { 'x-dashboard-token': viewerToken },
    })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('project_id required')
  })
})

// ---------------------------------------------------------------------------
// Login rate limit smoke test
// ---------------------------------------------------------------------------

describe('login rate limit', () => {
  it('returns 429 after the 11th attempt in one window', async () => {
    const db = makeDb()
    const app = makeApp(db)
    const { server, stop } = await startServer(app)
    let lastStatus = 0
    for (let i = 0; i < 11; i++) {
      const r = await httpReq(server, 'POST', '/api/v1/auth/login', { body: { token: 'bad' } })
      lastStatus = r.status
    }
    await stop()
    expect(lastStatus).toBe(429)
  }, 15000)
})

// ---------------------------------------------------------------------------
// requireBotOrAdmin
// ---------------------------------------------------------------------------

describe('requireBotOrAdmin middleware', () => {
  let stop: () => Promise<void>
  let server: ReturnType<typeof createServer>
  let adminToken: string
  let memberToken: string
  let botToken: string

  beforeEach(async () => {
    const db = makeDb()
    const app = makeApp(db)
    const admin = createUser({ email: 'adm@test.com', name: 'Admin', global_role: 'admin' })
    const { token: at } = createUserToken({ user_id: admin.id })
    adminToken = at
    const member = createUser({ email: 'mem@test.com', name: 'Member', global_role: 'member' })
    const { token: mt } = createUserToken({ user_id: member.id })
    memberToken = mt
    const bot = createUser({ email: 'bot@claudepaw.local', name: 'Bot', global_role: 'bot' })
    const { token: bt } = createUserToken({ user_id: bot.id })
    botToken = bt
    ;({ server, stop } = await startServer(app))
  })
  afterEach(async () => { await stop() })

  it('admin passes', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/bot-or-admin', {
      headers: { 'x-dashboard-token': adminToken },
    })
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
  })

  it('bot passes', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/bot-or-admin', {
      headers: { 'x-dashboard-token': botToken },
    })
    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
  })

  it('member gets 403', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/bot-or-admin', {
      headers: { 'x-dashboard-token': memberToken },
    })
    expect(res.status).toBe(403)
    expect((res.body as { error: string }).error).toBe('bot or admin required')
  })

  it('unauthenticated gets 401', async () => {
    const res = await httpReq(server, 'POST', '/api/v1/bot-or-admin')
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// ensureAuthBootstrap -- bot user bootstrap
// ---------------------------------------------------------------------------

describe('ensureAuthBootstrap -- bot user bootstrap', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('does not create bot user when BOT_API_TOKEN is unset', () => {
    const db = makeDb()
    initUserStore(db)
    vi.stubEnv('DASHBOARD_API_TOKEN', 'admin-tok')
    vi.stubEnv('BOT_API_TOKEN', '')
    ensureAuthBootstrap(db)
    const bots = (db.prepare('SELECT * FROM users WHERE global_role = ?').all('bot') as Array<{ id: number }>)
    expect(bots).toHaveLength(0)
  })

  it('creates bot user + hashed token when BOT_API_TOKEN is set', () => {
    const db = makeDb()
    initUserStore(db)
    vi.stubEnv('DASHBOARD_API_TOKEN', 'admin-tok')
    vi.stubEnv('BOT_API_TOKEN', 'bot-secret-tok')
    ensureAuthBootstrap(db)
    const bots = (db.prepare('SELECT * FROM users WHERE global_role = ?').all('bot') as Array<{ id: number; email: string; name: string }>)
    expect(bots).toHaveLength(1)
    expect(bots[0].email).toBe('bot@claudepaw.local')
    expect(bots[0].name).toBe('ClaudePaw Bot')
    const tokens = db.prepare('SELECT token_hash, label FROM user_tokens WHERE user_id = ?').all(bots[0].id) as Array<{ token_hash: string; label: string }>
    expect(tokens).toHaveLength(1)
    expect(tokens[0].token_hash).not.toBe('bot-secret-tok')
    expect(tokens[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(tokens[0].label).toBe('bootstrap from BOT_API_TOKEN')
  })

  it('bot user has no project memberships', () => {
    const db = makeDb()
    db.prepare(`INSERT INTO projects (id, name) VALUES ('proj-x','X')`).run()
    initUserStore(db)
    vi.stubEnv('DASHBOARD_API_TOKEN', 'admin-tok')
    vi.stubEnv('BOT_API_TOKEN', 'bot-tok')
    ensureAuthBootstrap(db)
    const bot = (db.prepare('SELECT id FROM users WHERE global_role = ?').get('bot') as { id: number } | undefined)
    expect(bot).toBeDefined()
    const memberships = db.prepare('SELECT * FROM project_members WHERE user_id = ?').all(bot!.id) as Array<unknown>
    expect(memberships).toHaveLength(0)
  })

  it('idempotent -- second call does not create a second bot user', () => {
    const db = makeDb()
    initUserStore(db)
    vi.stubEnv('DASHBOARD_API_TOKEN', 'admin-tok')
    vi.stubEnv('BOT_API_TOKEN', 'bot-tok')
    ensureAuthBootstrap(db)
    ensureAuthBootstrap(db)
    const bots = (db.prepare('SELECT * FROM users WHERE global_role = ?').all('bot') as Array<unknown>)
    expect(bots).toHaveLength(1)
  })

  it('respects BOT_USER_EMAIL and BOT_USER_NAME overrides', () => {
    const db = makeDb()
    initUserStore(db)
    vi.stubEnv('DASHBOARD_API_TOKEN', 'admin-tok')
    vi.stubEnv('BOT_API_TOKEN', 'bot-tok')
    vi.stubEnv('BOT_USER_EMAIL', 'custom-bot@example.com')
    vi.stubEnv('BOT_USER_NAME', 'Custom Bot Name')
    ensureAuthBootstrap(db)
    const bot = (db.prepare('SELECT * FROM users WHERE global_role = ?').get('bot') as { email: string; name: string } | undefined)
    expect(bot).toBeDefined()
    expect(bot!.email).toBe('custom-bot@example.com')
    expect(bot!.name).toBe('Custom Bot Name')
  })

  it('creates bot user even when admin users already exist', () => {
    const db = makeDb()
    initUserStore(db)
    // Simulate an already-bootstrapped deployment: admin exists, bot does not
    createUser({ email: 'admin@test.com', name: 'Admin', global_role: 'admin' })
    vi.stubEnv('BOT_API_TOKEN', 'new-bot-tok')
    ensureAuthBootstrap(db)
    const bots = (db.prepare('SELECT * FROM users WHERE global_role = ?').all('bot') as Array<unknown>)
    expect(bots).toHaveLength(1)
    // Admin count unchanged
    const admins = (db.prepare('SELECT * FROM users WHERE global_role = ?').all('admin') as Array<unknown>)
    expect(admins).toHaveLength(1)
  })
})
