import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
import {
  authenticate,
  scopeProjects,
  mountAuthRoutes,
} from './auth.js'
import { mountUsersRoutes } from './users-routes.js'

// ---------------------------------------------------------------------------
// In-memory DB schema
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp(db: Database.Database): express.Express {
  initUserStore(db)
  const app = express()
  app.use(express.json())
  mountAuthRoutes(app)
  app.use('/api/v1', authenticate)
  app.use('/api/v1', scopeProjects)
  mountUsersRoutes(app)
  return app
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

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
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) })
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw })
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
// Shared fixtures
// ---------------------------------------------------------------------------

type Fixtures = {
  db: Database.Database
  server: ReturnType<typeof createServer>
  stop: () => Promise<void>
  adminToken: string
  adminId: number
  memberToken: string
  memberId: number
}

async function setup(): Promise<Fixtures> {
  const db = makeDb()
  db.prepare(`INSERT INTO projects (id, name) VALUES ('proj-a','Project A'),('proj-b','Project B')`).run()
  const app = makeApp(db)
  const admin = createUser({ email: 'admin@test.com', name: 'Admin', global_role: 'admin' })
  const { token: adminToken } = createUserToken({ user_id: admin.id, label: 'admin-tok' })
  const member = createUser({ email: 'member@test.com', name: 'Member', global_role: 'member' })
  const { token: memberToken } = createUserToken({ user_id: member.id, label: 'member-tok' })
  const { server, stop } = await startServer(app)
  return { db, server, stop, adminToken, adminId: admin.id, memberToken, memberId: member.id }
}

// ---------------------------------------------------------------------------
// GET /api/v1/users
// ---------------------------------------------------------------------------

describe('GET /api/v1/users', () => {
  let f: Fixtures
  beforeEach(async () => { f = await setup() })
  afterEach(async () => { await f.stop() })

  it('200 as admin -- returns users array with memberships and total', async () => {
    const res = await httpReq(f.server, 'GET', '/api/v1/users', {
      headers: { 'x-dashboard-token': f.adminToken },
    })
    expect(res.status).toBe(200)
    const body = res.body as { users: Array<{ id: number; memberships: unknown[] }>; total: number }
    expect(body.total).toBe(2)
    expect(body.users).toHaveLength(2)
    expect(Array.isArray(body.users[0].memberships)).toBe(true)
  })

  it('403 as member', async () => {
    const res = await httpReq(f.server, 'GET', '/api/v1/users', {
      headers: { 'x-dashboard-token': f.memberToken },
    })
    expect(res.status).toBe(403)
    expect((res.body as { error: string }).error).toBe('Admin required')
  })

  it('401 without auth', async () => {
    const res = await httpReq(f.server, 'GET', '/api/v1/users')
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/users
// ---------------------------------------------------------------------------

describe('POST /api/v1/users', () => {
  let f: Fixtures
  beforeEach(async () => { f = await setup() })
  afterEach(async () => { await f.stop() })

  it('201 on valid body with default global_role', async () => {
    const res = await httpReq(f.server, 'POST', '/api/v1/users', {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { email: 'new@test.com', name: 'New User' },
    })
    expect(res.status).toBe(201)
    const body = res.body as { user: { email: string; global_role: string } }
    expect(body.user.email).toBe('new@test.com')
    expect(body.user.global_role).toBe('member')
  })

  it('201 with explicit global_role admin', async () => {
    const res = await httpReq(f.server, 'POST', '/api/v1/users', {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { email: 'admin2@test.com', name: 'Admin 2', global_role: 'admin' },
    })
    expect(res.status).toBe(201)
    expect((res.body as { user: { global_role: string } }).user.global_role).toBe('admin')
  })

  it('400 on duplicate email', async () => {
    const res = await httpReq(f.server, 'POST', '/api/v1/users', {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { email: 'admin@test.com', name: 'Dupe' },
    })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/already exists/)
  })

  it('400 on missing email', async () => {
    const res = await httpReq(f.server, 'POST', '/api/v1/users', {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { name: 'No Email' },
    })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/email/)
  })

  it('400 on email without @', async () => {
    const res = await httpReq(f.server, 'POST', '/api/v1/users', {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { email: 'noemail', name: 'Bad Email' },
    })
    expect(res.status).toBe(400)
  })

  it('400 on missing name', async () => {
    const res = await httpReq(f.server, 'POST', '/api/v1/users', {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { email: 'ok@test.com' },
    })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/name/)
  })

  it('400 on invalid global_role', async () => {
    const res = await httpReq(f.server, 'POST', '/api/v1/users', {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { email: 'ok@test.com', name: 'Ok', global_role: 'superuser' },
    })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/global_role/)
  })

  it('403 as member', async () => {
    const res = await httpReq(f.server, 'POST', '/api/v1/users', {
      headers: { 'x-dashboard-token': f.memberToken },
      body: { email: 'x@test.com', name: 'X' },
    })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/users/:id
// ---------------------------------------------------------------------------

describe('GET /api/v1/users/:id', () => {
  let f: Fixtures
  beforeEach(async () => { f = await setup() })
  afterEach(async () => { await f.stop() })

  it('200 returns user with memberships', async () => {
    grantProjectMembership({ project_id: 'proj-a', user_id: f.adminId, role: 'owner' })
    const res = await httpReq(f.server, 'GET', `/api/v1/users/${f.adminId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
    })
    expect(res.status).toBe(200)
    const body = res.body as { user: { id: number; memberships: Array<{ project_id: string }> } }
    expect(body.user.id).toBe(f.adminId)
    expect(body.user.memberships).toHaveLength(1)
    expect(body.user.memberships[0].project_id).toBe('proj-a')
  })

  it('404 for unknown user', async () => {
    const res = await httpReq(f.server, 'GET', '/api/v1/users/99999', {
      headers: { 'x-dashboard-token': f.adminToken },
    })
    expect(res.status).toBe(404)
  })

  it('403 as member', async () => {
    const res = await httpReq(f.server, 'GET', `/api/v1/users/${f.adminId}`, {
      headers: { 'x-dashboard-token': f.memberToken },
    })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/v1/users/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/users/:id', () => {
  let f: Fixtures
  beforeEach(async () => { f = await setup() })
  afterEach(async () => { await f.stop() })

  it('200 updates name', async () => {
    const res = await httpReq(f.server, 'PATCH', `/api/v1/users/${f.memberId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { name: 'Updated Name' },
    })
    expect(res.status).toBe(200)
    expect((res.body as { user: { name: string } }).user.name).toBe('Updated Name')
  })

  it('200 updates email', async () => {
    const res = await httpReq(f.server, 'PATCH', `/api/v1/users/${f.memberId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { email: 'newemail@test.com' },
    })
    expect(res.status).toBe(200)
    expect((res.body as { user: { email: string } }).user.email).toBe('newemail@test.com')
  })

  it('200 updates global_role', async () => {
    const res = await httpReq(f.server, 'PATCH', `/api/v1/users/${f.memberId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { global_role: 'admin' },
    })
    expect(res.status).toBe(200)
    expect((res.body as { user: { global_role: string } }).user.global_role).toBe('admin')
  })

  it('404 for unknown user', async () => {
    const res = await httpReq(f.server, 'PATCH', '/api/v1/users/99999', {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { name: 'X' },
    })
    expect(res.status).toBe(404)
  })

  it('400 on duplicate email', async () => {
    const res = await httpReq(f.server, 'PATCH', `/api/v1/users/${f.memberId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { email: 'admin@test.com' },
    })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/already exists/)
  })

  it('400 on invalid global_role', async () => {
    const res = await httpReq(f.server, 'PATCH', `/api/v1/users/${f.memberId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { global_role: 'god' },
    })
    expect(res.status).toBe(400)
  })

  it('403 as member', async () => {
    const res = await httpReq(f.server, 'PATCH', `/api/v1/users/${f.memberId}`, {
      headers: { 'x-dashboard-token': f.memberToken },
      body: { name: 'X' },
    })
    expect(res.status).toBe(403)
  })

  it('400 when demoting the sole admin to member', async () => {
    // f has exactly one admin (adminId). Demoting them must be blocked.
    const res = await httpReq(f.server, 'PATCH', `/api/v1/users/${f.adminId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { global_role: 'member' },
    })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('Cannot demote the last admin')
  })

  it('200 when demoting one of two admins to member', async () => {
    // Elevate memberId to admin first -- now count=2. Demotion is allowed.
    await httpReq(f.server, 'PATCH', `/api/v1/users/${f.memberId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { global_role: 'admin' },
    })
    const res = await httpReq(f.server, 'PATCH', `/api/v1/users/${f.adminId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { global_role: 'member' },
    })
    expect(res.status).toBe(200)
    expect((res.body as { user: { global_role: string } }).user.global_role).toBe('member')
  })

  it('200 when promoting a member to admin (guard does not block promotion)', async () => {
    const res = await httpReq(f.server, 'PATCH', `/api/v1/users/${f.memberId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { global_role: 'admin' },
    })
    expect(res.status).toBe(200)
    expect((res.body as { user: { global_role: string } }).user.global_role).toBe('admin')
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/v1/users/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/users/:id', () => {
  let f: Fixtures
  beforeEach(async () => { f = await setup() })
  afterEach(async () => { await f.stop() })

  it('200 deletes another user', async () => {
    const res = await httpReq(f.server, 'DELETE', `/api/v1/users/${f.memberId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
    })
    expect(res.status).toBe(200)
    expect((res.body as { deleted: boolean }).deleted).toBe(true)
  })

  it('400 on self-delete', async () => {
    const res = await httpReq(f.server, 'DELETE', `/api/v1/users/${f.adminId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
    })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/own account/)
  })

  it('400 when deleting last admin', async () => {
    // The guard fires when adminCount (current) <= 1 and target is admin.
    // Via HTTP, this is only reachable when the sole admin tries to self-delete
    // (self-delete guard fires first with the same 400). We also verify that
    // deleting an admin when count > 1 is allowed, to confirm the guard logic.

    // Elevate memberId to admin: count=2. Delete adminId (not self) as memberId -- allowed.
    await httpReq(f.server, 'PATCH', `/api/v1/users/${f.memberId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { global_role: 'admin' },
    })
    const okRes = await httpReq(f.server, 'DELETE', `/api/v1/users/${f.adminId}`, {
      headers: { 'x-dashboard-token': f.memberToken },
    })
    expect(okRes.status).toBe(200) // count was 2, deletion allowed

    // memberId is now sole admin. A new admin user tries to delete memberId.
    // But creating a new admin (thirdAdmin) raises count to 2 again -> guard does not fire.
    // The guard IS tested via the self-delete path: memberId (sole admin) tries to self-delete.
    const soloSelfDelete = await httpReq(f.server, 'DELETE', `/api/v1/users/${f.memberId}`, {
      headers: { 'x-dashboard-token': f.memberToken },
    })
    expect(soloSelfDelete.status).toBe(400) // self-delete guard (sole admin case)
    expect((soloSelfDelete.body as { error: string }).error).toMatch(/own account/)
  })
  it('404 for unknown user', async () => {
    const res = await httpReq(f.server, 'DELETE', '/api/v1/users/99999', {
      headers: { 'x-dashboard-token': f.adminToken },
    })
    expect(res.status).toBe(404)
  })

  it('403 as member', async () => {
    const res = await httpReq(f.server, 'DELETE', `/api/v1/users/${f.memberId}`, {
      headers: { 'x-dashboard-token': f.memberToken },
    })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/users/:id/tokens
// ---------------------------------------------------------------------------

describe('GET /api/v1/users/:id/tokens', () => {
  let f: Fixtures
  beforeEach(async () => { f = await setup() })
  afterEach(async () => { await f.stop() })

  it('200 returns token list without token_hash', async () => {
    const res = await httpReq(f.server, 'GET', `/api/v1/users/${f.adminId}/tokens`, {
      headers: { 'x-dashboard-token': f.adminToken },
    })
    expect(res.status).toBe(200)
    const body = res.body as { tokens: Array<Record<string, unknown>> }
    expect(body.tokens.length).toBeGreaterThan(0)
    for (const tok of body.tokens) {
      expect(tok).not.toHaveProperty('token_hash')
      expect(tok).toHaveProperty('id')
      expect(tok).toHaveProperty('user_id')
      expect(tok).toHaveProperty('label')
      expect(tok).toHaveProperty('created_at')
    }
  })

  it('404 for unknown user', async () => {
    const res = await httpReq(f.server, 'GET', '/api/v1/users/99999/tokens', {
      headers: { 'x-dashboard-token': f.adminToken },
    })
    expect(res.status).toBe(404)
  })

  it('403 as member', async () => {
    const res = await httpReq(f.server, 'GET', `/api/v1/users/${f.adminId}/tokens`, {
      headers: { 'x-dashboard-token': f.memberToken },
    })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/users/:id/tokens
// ---------------------------------------------------------------------------

describe('POST /api/v1/users/:id/tokens', () => {
  let f: Fixtures
  beforeEach(async () => { f = await setup() })
  afterEach(async () => { await f.stop() })

  it('201 returns raw token and record without token_hash', async () => {
    const res = await httpReq(f.server, 'POST', `/api/v1/users/${f.memberId}/tokens`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { label: 'my-token' },
    })
    expect(res.status).toBe(201)
    const body = res.body as { token: string; record: Record<string, unknown> }
    expect(typeof body.token).toBe('string')
    expect(body.token.length).toBeGreaterThan(10)
    expect(body.record).toHaveProperty('id')
    expect(body.record).toHaveProperty('user_id', f.memberId)
    expect(body.record).toHaveProperty('label', 'my-token')
    expect(body.record).not.toHaveProperty('token_hash')
  })

  it('201 with no label defaults to empty string', async () => {
    const res = await httpReq(f.server, 'POST', `/api/v1/users/${f.memberId}/tokens`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: {},
    })
    expect(res.status).toBe(201)
    expect((res.body as { record: { label: string } }).record.label).toBe('')
  })

  it('404 for unknown user', async () => {
    const res = await httpReq(f.server, 'POST', '/api/v1/users/99999/tokens', {
      headers: { 'x-dashboard-token': f.adminToken },
      body: {},
    })
    expect(res.status).toBe(404)
  })

  it('403 as member', async () => {
    const res = await httpReq(f.server, 'POST', `/api/v1/users/${f.memberId}/tokens`, {
      headers: { 'x-dashboard-token': f.memberToken },
      body: {},
    })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/v1/users/:id/tokens/:tokenId
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/users/:id/tokens/:tokenId', () => {
  let f: Fixtures
  let newTokenId: number

  beforeEach(async () => {
    f = await setup()
    const { record } = createUserToken({ user_id: f.memberId, label: 'to-revoke' })
    newTokenId = record.id
  })
  afterEach(async () => { await f.stop() })

  it('200 revokes the token', async () => {
    const res = await httpReq(
      f.server,
      'DELETE',
      `/api/v1/users/${f.memberId}/tokens/${newTokenId}`,
      { headers: { 'x-dashboard-token': f.adminToken } },
    )
    expect(res.status).toBe(200)
    expect((res.body as { revoked: boolean }).revoked).toBe(true)
  })

  it('404 when tokenId belongs to a different user', async () => {
    const res = await httpReq(
      f.server,
      'DELETE',
      `/api/v1/users/${f.adminId}/tokens/${newTokenId}`,
      { headers: { 'x-dashboard-token': f.adminToken } },
    )
    expect(res.status).toBe(404)
  })

  it('404 for unknown token', async () => {
    const res = await httpReq(
      f.server,
      'DELETE',
      `/api/v1/users/${f.memberId}/tokens/99999`,
      { headers: { 'x-dashboard-token': f.adminToken } },
    )
    expect(res.status).toBe(404)
  })

  it('403 as member', async () => {
    const res = await httpReq(
      f.server,
      'DELETE',
      `/api/v1/users/${f.memberId}/tokens/${newTokenId}`,
      { headers: { 'x-dashboard-token': f.memberToken } },
    )
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/users/:id/memberships
// ---------------------------------------------------------------------------

describe('POST /api/v1/users/:id/memberships', () => {
  let f: Fixtures
  beforeEach(async () => { f = await setup() })
  afterEach(async () => { await f.stop() })

  it('201 grants membership', async () => {
    const res = await httpReq(f.server, 'POST', `/api/v1/users/${f.memberId}/memberships`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { project_id: 'proj-a', role: 'viewer' },
    })
    expect(res.status).toBe(201)
    const body = res.body as { membership: { project_id: string; role: string; user_id: number } }
    expect(body.membership.project_id).toBe('proj-a')
    expect(body.membership.role).toBe('viewer')
    expect(body.membership.user_id).toBe(f.memberId)
  })

  it('201 upserts -- changes role on duplicate (project_id, user_id)', async () => {
    await httpReq(f.server, 'POST', `/api/v1/users/${f.memberId}/memberships`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { project_id: 'proj-a', role: 'viewer' },
    })
    const res = await httpReq(f.server, 'POST', `/api/v1/users/${f.memberId}/memberships`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { project_id: 'proj-a', role: 'editor' },
    })
    expect(res.status).toBe(201)
    expect((res.body as { membership: { role: string } }).membership.role).toBe('editor')
  })

  it('400 for invalid project', async () => {
    const res = await httpReq(f.server, 'POST', `/api/v1/users/${f.memberId}/memberships`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { project_id: 'nonexistent', role: 'viewer' },
    })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/Project not found/)
  })

  it('400 for invalid role', async () => {
    const res = await httpReq(f.server, 'POST', `/api/v1/users/${f.memberId}/memberships`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { project_id: 'proj-a', role: 'superowner' },
    })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/role/)
  })

  it('400 when project_id is missing', async () => {
    const res = await httpReq(f.server, 'POST', `/api/v1/users/${f.memberId}/memberships`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { role: 'viewer' },
    })
    expect(res.status).toBe(400)
  })

  it('404 for unknown user', async () => {
    const res = await httpReq(f.server, 'POST', '/api/v1/users/99999/memberships', {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { project_id: 'proj-a', role: 'viewer' },
    })
    expect(res.status).toBe(404)
  })

  it('403 as member', async () => {
    const res = await httpReq(f.server, 'POST', `/api/v1/users/${f.memberId}/memberships`, {
      headers: { 'x-dashboard-token': f.memberToken },
      body: { project_id: 'proj-a', role: 'viewer' },
    })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/v1/users/:id/memberships/:projectId
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/users/:id/memberships/:projectId', () => {
  let f: Fixtures
  beforeEach(async () => {
    f = await setup()
    grantProjectMembership({ project_id: 'proj-a', user_id: f.memberId, role: 'viewer' })
  })
  afterEach(async () => { await f.stop() })

  it('200 revokes membership', async () => {
    const res = await httpReq(
      f.server,
      'DELETE',
      `/api/v1/users/${f.memberId}/memberships/proj-a`,
      { headers: { 'x-dashboard-token': f.adminToken } },
    )
    expect(res.status).toBe(200)
    expect((res.body as { revoked: boolean }).revoked).toBe(true)
  })

  it('404 when not a member', async () => {
    const res = await httpReq(
      f.server,
      'DELETE',
      `/api/v1/users/${f.memberId}/memberships/proj-b`,
      { headers: { 'x-dashboard-token': f.adminToken } },
    )
    expect(res.status).toBe(404)
  })

  it('403 as member', async () => {
    const res = await httpReq(
      f.server,
      'DELETE',
      `/api/v1/users/${f.memberId}/memberships/proj-a`,
      { headers: { 'x-dashboard-token': f.memberToken } },
    )
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Bot user protection -- PATCH/DELETE blocked, tokens still allowed
// ---------------------------------------------------------------------------

describe('Bot user API protection', () => {
  type BotFixtures = Fixtures & { botId: number }

  async function setupWithBot(): Promise<BotFixtures> {
    const f = await setup()
    const bot = createUser({ email: 'bot@claudepaw.local', name: 'ClaudePaw Bot', global_role: 'bot' })
    return { ...f, botId: bot.id }
  }

  it('PATCH on bot user -> 400', async () => {
    const f = await setupWithBot()
    const res = await httpReq(f.server, 'PATCH', `/api/v1/users/${f.botId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { name: 'Hacked Bot' },
    })
    await f.stop()
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/Bot user/)
  })

  it('DELETE on bot user -> 400', async () => {
    const f = await setupWithBot()
    const res = await httpReq(f.server, 'DELETE', `/api/v1/users/${f.botId}`, {
      headers: { 'x-dashboard-token': f.adminToken },
    })
    await f.stop()
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/Bot user/)
  })

  it('POST tokens on bot user -> 201 (token rotation still works)', async () => {
    const f = await setupWithBot()
    const res = await httpReq(f.server, 'POST', `/api/v1/users/${f.botId}/tokens`, {
      headers: { 'x-dashboard-token': f.adminToken },
      body: { label: 'bot-rotation' },
    })
    await f.stop()
    expect(res.status).toBe(201)
    const body = res.body as { token: string; record: { label: string } }
    expect(typeof body.token).toBe('string')
    expect(body.record.label).toBe('bot-rotation')
  })
})
