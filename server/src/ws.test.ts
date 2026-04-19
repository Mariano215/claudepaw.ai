import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import express from 'express'
import { createServer } from 'node:http'
import { request as nodeRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import WebSocket from 'ws'
import { createHmac } from 'node:crypto'
import {
  initUserStore,
  createUser,
  createUserToken,
  grantProjectMembership,
} from './users.js'
import {
  mountAuthRoutes,
  issueWsTicket,
  verifyWsTicket,
} from './auth.js'
import { setupWebSocket, canDeliverToClient } from './ws.js'
import type { ConnectedClient } from './ws.js'

// ---------------------------------------------------------------------------
// Shared DB schema
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      global_role TEXT NOT NULL DEFAULT 'member' CHECK(global_role IN ('admin','member')),
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
// HTTP helper
// ---------------------------------------------------------------------------

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
// WS helpers
// ---------------------------------------------------------------------------

function wsConnect(port: number): Promise<{ ws: WebSocket; waitFor: (type: string) => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const pending = new Map<string, (msg: unknown) => void>()
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        const cb = pending.get(msg.type as string)
        if (cb) {
          pending.delete(msg.type as string)
          cb(msg)
        }
      } catch { /* ignore */ }
    })
    ws.on('open', () => {
      resolve({
        ws,
        waitFor: (type: string) => new Promise(res => pending.set(type, res)),
      })
    })
    ws.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Full server fixture
// ---------------------------------------------------------------------------

type ServerHandle = {
  server: ReturnType<typeof createServer>
  port: number
  stop: () => Promise<void>
}

function startFullServer(db: Database.Database): Promise<ServerHandle> {
  initUserStore(db)
  const app = express()
  app.use(express.json())
  mountAuthRoutes(app)
  const server = createServer(app)
  setupWebSocket(server)
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        server,
        port: addr.port,
        stop: () => new Promise(res => server.close(() => res())),
      })
    })
    server.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// issueWsTicket / verifyWsTicket unit tests
// ---------------------------------------------------------------------------

describe('issueWsTicket', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('returns ticket string and expires_at ~60s from now', () => {
    vi.stubEnv('WS_SECRET', 'testsecret')
    const before = Date.now()
    const { ticket, expires_at } = issueWsTicket(42)
    expect(typeof ticket).toBe('string')
    expect(ticket.split('.')).toHaveLength(4)
    expect(expires_at).toBeGreaterThanOrEqual(before + 59_000)
    expect(expires_at).toBeLessThanOrEqual(before + 61_000)
  })

  it('ticket encodes the user_id as first segment', () => {
    vi.stubEnv('WS_SECRET', 'testsecret')
    const { ticket } = issueWsTicket(99)
    const [uid] = ticket.split('.')
    expect(uid).toBe('99')
  })
})

describe('verifyWsTicket', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('verifies a valid ticket and returns userId + nonce', () => {
    vi.stubEnv('WS_SECRET', 'mySecret')
    const { ticket } = issueWsTicket(7)
    const result = verifyWsTicket(ticket)
    expect(result.userId).toBe(7)
    expect(typeof result.nonce).toBe('string')
    expect(result.nonce.length).toBeGreaterThan(0)
  })

  it('throws on malformed ticket (wrong segment count)', () => {
    vi.stubEnv('WS_SECRET', 'mySecret')
    expect(() => verifyWsTicket('foo.bar')).toThrow('malformed ticket')
  })

  it('throws on garbage ticket', () => {
    vi.stubEnv('WS_SECRET', 'mySecret')
    expect(() => verifyWsTicket('not.a.real.ticket')).toThrow()
  })

  it('throws on expired ticket (issued_at > 60s ago)', () => {
    vi.stubEnv('WS_SECRET', 'mySecret')
    const userId = 5
    const issuedAt = Date.now() - 61_000
    const nonce = 'deadbeef'
    const payload = `${userId}.${issuedAt}.${nonce}`
    const hmac = createHmac('sha256', 'mySecret').update(payload).digest('hex')
    const ticket = `${payload}.${hmac}`
    expect(() => verifyWsTicket(ticket)).toThrow('ticket expired')
  })

  it('throws on tampered HMAC', () => {
    vi.stubEnv('WS_SECRET', 'mySecret')
    const { ticket } = issueWsTicket(3)
    const parts = ticket.split('.')
    parts[3] = 'a'.repeat(parts[3]!.length)
    expect(() => verifyWsTicket(parts.join('.'))).toThrow()
  })

  it('throws when the same ticket is verified twice (replay)', () => {
    vi.stubEnv('WS_SECRET', 'mySecret')
    const { ticket } = issueWsTicket(11)
    verifyWsTicket(ticket)
    expect(() => verifyWsTicket(ticket)).toThrow('ticket already used')
  })
})

// ---------------------------------------------------------------------------
// GET /api/v1/auth/ws-ticket HTTP endpoint
// ---------------------------------------------------------------------------

describe('GET /api/v1/auth/ws-ticket', () => {
  let stop: () => Promise<void>
  let server: ReturnType<typeof createServer>
  let rawToken: string

  beforeEach(async () => {
    vi.stubEnv('WS_SECRET', 'endpointsecret')
    const db = makeDb()
    initUserStore(db)
    const app = express()
    app.use(express.json())
    mountAuthRoutes(app)
    const admin = createUser({ email: 'admin@t.com', name: 'Admin', global_role: 'admin' })
    const { token } = createUserToken({ user_id: admin.id })
    rawToken = token
    const s = createServer(app)
    await new Promise<void>((res, rej) => { s.listen(0, '127.0.0.1', res); s.on('error', rej) })
    server = s
    stop = () => new Promise(res => s.close(() => res()))
  })
  afterEach(async () => { await stop(); vi.unstubAllEnvs() })

  it('authenticated user gets ticket with correct shape', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/auth/ws-ticket', {
      headers: { 'x-dashboard-token': rawToken },
    })
    expect(res.status).toBe(200)
    const body = res.body as { ticket: string; expires_at: number }
    expect(typeof body.ticket).toBe('string')
    expect(body.ticket.split('.')).toHaveLength(4)
    expect(typeof body.expires_at).toBe('number')
    expect(body.expires_at).toBeGreaterThan(Date.now())
  })

  it('unauthenticated request returns 401', async () => {
    const res = await httpReq(server, 'GET', '/api/v1/auth/ws-ticket')
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// canDeliverToClient unit tests
// ---------------------------------------------------------------------------

function makeClient(overrides: Partial<ConnectedClient> = {}): ConnectedClient {
  return {
    ws: {} as WebSocket,
    clientId: 'anon-1',
    connectedAt: Date.now(),
    ...overrides,
  }
}

describe('canDeliverToClient', () => {
  it('bot (mac-primary) gets everything regardless of project', () => {
    const client = makeClient({ clientId: 'mac-primary' })
    expect(canDeliverToClient(client, 'proj-x')).toBe(true)
    expect(canDeliverToClient(client, null)).toBe(true)
    expect(canDeliverToClient(client, undefined)).toBe(true)
  })

  it('admin user gets everything', () => {
    const client = makeClient({ user: { id: 1, isAdmin: true, allowedProjectIds: null } })
    expect(canDeliverToClient(client, 'proj-x')).toBe(true)
    expect(canDeliverToClient(client, null)).toBe(true)
  })

  it('messages with no project_id go to everyone including members', () => {
    const client = makeClient({ user: { id: 2, isAdmin: false, allowedProjectIds: ['proj-a'] } })
    expect(canDeliverToClient(client, null)).toBe(true)
    expect(canDeliverToClient(client, undefined)).toBe(true)
  })

  it('member receives messages for allowed project', () => {
    const client = makeClient({ user: { id: 3, isAdmin: false, allowedProjectIds: ['proj-a', 'proj-b'] } })
    expect(canDeliverToClient(client, 'proj-a')).toBe(true)
    expect(canDeliverToClient(client, 'proj-b')).toBe(true)
  })

  it('member does NOT receive messages for disallowed project', () => {
    const client = makeClient({ user: { id: 3, isAdmin: false, allowedProjectIds: ['proj-a'] } })
    expect(canDeliverToClient(client, 'proj-x')).toBe(false)
  })

  it('client with no user object is denied project-specific messages', () => {
    const client = makeClient({ clientId: 'unregistered-browser' })
    expect(canDeliverToClient(client, 'proj-x')).toBe(false)
  })

  it('client with no user object passes null-project messages', () => {
    const client = makeClient({ clientId: 'unregistered-browser' })
    expect(canDeliverToClient(client, null)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// WebSocket integration: bot path
// ---------------------------------------------------------------------------

describe('WebSocket register: bot path', () => {
  let handle: ServerHandle

  beforeEach(async () => {
    vi.stubEnv('WS_SECRET', 'botsecret')
    const db = makeDb()
    handle = await startFullServer(db)
  })
  afterEach(async () => { await handle.stop(); vi.unstubAllEnvs() })

  it('bot registers with valid HMAC and gets registered message', async () => {
    const { ws, waitFor } = await wsConnect(handle.port)
    const regPromise = waitFor('registered')
    const ts = Date.now()
    const token = createHmac('sha256', 'botsecret').update(`mac-primary:${ts}`).digest('hex')
    ws.send(JSON.stringify({ type: 'register', clientId: 'mac-primary', token, ts }))
    const msg = await regPromise as { type: string; clientId: string }
    expect(msg.type).toBe('registered')
    expect(msg.clientId).toBe('mac-primary')
    ws.close()
  })

  it('bot with invalid HMAC is rejected with auth_error', async () => {
    const { ws, waitFor } = await wsConnect(handle.port)
    const errPromise = waitFor('auth_error')
    const ts = Date.now()
    ws.send(JSON.stringify({ type: 'register', clientId: 'mac-primary', token: 'deadbeef'.repeat(8), ts }))
    const msg = await errPromise as { reason: string }
    expect(msg.reason).toBe('invalid token')
    await new Promise<void>(res => ws.on('close', () => res()))
  })

  it('bot missing token field gets auth_error', async () => {
    const { ws, waitFor } = await wsConnect(handle.port)
    const errPromise = waitFor('auth_error')
    ws.send(JSON.stringify({ type: 'register', clientId: 'mac-primary', ts: Date.now() }))
    const msg = await errPromise as { reason: string }
    expect(msg.reason).toBe('missing token or timestamp')
    await new Promise<void>(res => ws.on('close', () => res()))
  })
})

// ---------------------------------------------------------------------------
// WebSocket integration: browser client path
// ---------------------------------------------------------------------------

describe('WebSocket register: browser client path', () => {
  let handle: ServerHandle
  let db: Database.Database
  let adminId: number
  let memberId: number

  beforeEach(async () => {
    vi.stubEnv('WS_SECRET', 'browsersecret')
    db = makeDb()
    db.prepare(`INSERT INTO projects (id, name) VALUES ('proj-a','A'),('proj-b','B')`).run()
    initUserStore(db)
    const admin = createUser({ email: 'adm@t.com', name: 'Adm', global_role: 'admin' })
    adminId = admin.id
    const member = createUser({ email: 'mem@t.com', name: 'Mem', global_role: 'member' })
    grantProjectMembership({ project_id: 'proj-a', user_id: member.id, role: 'viewer' })
    memberId = member.id
    handle = await startFullServer(db)
  })
  afterEach(async () => { await handle.stop(); vi.unstubAllEnvs() })

  it('browser client with valid ticket registers successfully', async () => {
    const { ticket } = issueWsTicket(memberId)
    const { ws, waitFor } = await wsConnect(handle.port)
    const regPromise = waitFor('registered')
    ws.send(JSON.stringify({ type: 'register', clientId: `browser-${memberId}`, userTicket: ticket }))
    const msg = await regPromise as { type: string }
    expect(msg.type).toBe('registered')
    ws.close()
  })

  it('browser client without userTicket is rejected with close code 4401', async () => {
    const { ws, waitFor } = await wsConnect(handle.port)
    const errPromise = waitFor('auth_error')
    ws.send(JSON.stringify({ type: 'register', clientId: 'browser-x' }))
    await errPromise
    const closeCode = await new Promise<number>(res => ws.on('close', (code) => res(code)))
    expect(closeCode).toBe(4401)
  })

  it('stale ticket (>60s old) is rejected', async () => {
    const issuedAt = Date.now() - 61_000
    const nonce = 'aabbccdd'
    const payload = `${memberId}.${issuedAt}.${nonce}`
    const hmac = createHmac('sha256', 'browsersecret').update(payload).digest('hex')
    const staleTicket = `${payload}.${hmac}`

    const { ws, waitFor } = await wsConnect(handle.port)
    const errPromise = waitFor('auth_error')
    ws.send(JSON.stringify({ type: 'register', clientId: 'browser-stale', userTicket: staleTicket }))
    const msg = await errPromise as { reason: string }
    expect(msg.reason).toContain('expired')
    ws.close()
  })

  it('garbage ticket is rejected with close code 4401', async () => {
    const { ws, waitFor } = await wsConnect(handle.port)
    const errPromise = waitFor('auth_error')
    ws.send(JSON.stringify({ type: 'register', clientId: 'browser-garbage', userTicket: 'total.garbage.not.valid' }))
    await errPromise
    const closeCode = await new Promise<number>(res => ws.on('close', (code) => res(code)))
    expect(closeCode).toBe(4401)
  })

  it('already-used ticket is rejected (replay protection)', async () => {
    const { ticket } = issueWsTicket(adminId)

    const c1 = await wsConnect(handle.port)
    const reg1 = c1.waitFor('registered')
    c1.ws.send(JSON.stringify({ type: 'register', clientId: `browser-admin-1`, userTicket: ticket }))
    await reg1

    const c2 = await wsConnect(handle.port)
    const errPromise = c2.waitFor('auth_error')
    c2.ws.send(JSON.stringify({ type: 'register', clientId: `browser-admin-2`, userTicket: ticket }))
    const msg = await errPromise as { reason: string }
    expect(msg.reason).toContain('already used')
    c1.ws.close()
    c2.ws.close()
  })
})

// ---------------------------------------------------------------------------
// Broadcast filter: project-scoped events
// ---------------------------------------------------------------------------

describe('broadcast filter: feed events scoped to project members', () => {
  let handle: ServerHandle
  let db: Database.Database
  let memberAId: number
  let memberBId: number
  let adminId: number

  beforeEach(async () => {
    vi.stubEnv('WS_SECRET', 'filtersecret')
    db = makeDb()
    db.prepare(`INSERT INTO projects (id, name) VALUES ('proj-a','A'),('proj-b','B')`).run()
    initUserStore(db)

    const admin = createUser({ email: 'adm@t.com', name: 'Adm', global_role: 'admin' })
    adminId = admin.id

    const memberA = createUser({ email: 'ma@t.com', name: 'MemberA', global_role: 'member' })
    grantProjectMembership({ project_id: 'proj-a', user_id: memberA.id, role: 'viewer' })
    memberAId = memberA.id

    const memberB = createUser({ email: 'mb@t.com', name: 'MemberB', global_role: 'member' })
    grantProjectMembership({ project_id: 'proj-b', user_id: memberB.id, role: 'viewer' })
    memberBId = memberB.id

    handle = await startFullServer(db)
  })
  afterEach(async () => { await handle.stop(); vi.unstubAllEnvs() })

  async function registerBrowser(userId: number, clientId: string): Promise<{ ws: WebSocket; received: unknown[] }> {
    const { ticket } = issueWsTicket(userId)
    const { ws, waitFor } = await wsConnect(handle.port)
    const regPromise = waitFor('registered')
    ws.send(JSON.stringify({ type: 'register', clientId, userTicket: ticket }))
    await regPromise
    const received: unknown[] = []
    ws.on('message', (raw) => {
      try { received.push(JSON.parse(raw.toString())) } catch { /* ignore */ }
    })
    return { ws, received }
  }

  it('feed_update for proj-a delivered to proj-a member and admin, NOT proj-b member', async () => {
    const botTs = Date.now()
    const botToken = createHmac('sha256', 'filtersecret').update(`mac-primary:${botTs}`).digest('hex')
    const { ws: botWs, waitFor: botWait } = await wsConnect(handle.port)
    const botReg = botWait('registered')
    botWs.send(JSON.stringify({ type: 'register', clientId: 'mac-primary', token: botToken, ts: botTs }))
    await botReg

    const clientA = await registerBrowser(memberAId, 'browser-a')
    const clientB = await registerBrowser(memberBId, 'browser-b')
    const clientAdmin = await registerBrowser(adminId, 'browser-admin')

    botWs.send(JSON.stringify({
      type: 'feed_item',
      data: { agent_id: 'scout', action: 'test', project_id: 'proj-a' },
    }))

    await new Promise(res => setTimeout(res, 120))

    const hasFeed = (r: unknown[]) => r.some((m) => (m as Record<string, unknown>).type === 'feed_update')

    expect(hasFeed(clientA.received)).toBe(true)
    expect(hasFeed(clientB.received)).toBe(false)
    expect(hasFeed(clientAdmin.received)).toBe(true)

    botWs.close()
    clientA.ws.close()
    clientB.ws.close()
    clientAdmin.ws.close()
  }, 8000)
})

// ---------------------------------------------------------------------------
// Admin-only command: reset_agent_statuses
// ---------------------------------------------------------------------------

describe('admin-only WS command: reset_agent_statuses', () => {
  let handle: ServerHandle
  let db: Database.Database

  beforeEach(async () => {
    vi.stubEnv('WS_SECRET', 'adminsecret')
    db = makeDb()
    db.prepare(`INSERT INTO projects (id, name) VALUES ('proj-a','A')`).run()
    initUserStore(db)
    handle = await startFullServer(db)
  })
  afterEach(async () => { await handle.stop(); vi.unstubAllEnvs() })

  it('member sending reset_agent_statuses gets error response', async () => {
    const member = createUser({ email: 'mem@t.com', name: 'Mem', global_role: 'member' })
    grantProjectMembership({ project_id: 'proj-a', user_id: member.id, role: 'viewer' })

    const { ticket } = issueWsTicket(member.id)
    const { ws, waitFor } = await wsConnect(handle.port)
    const regPromise = waitFor('registered')
    ws.send(JSON.stringify({ type: 'register', clientId: 'browser-mem', userTicket: ticket }))
    await regPromise

    const errPromise = waitFor('error')
    ws.send(JSON.stringify({ type: 'reset_agent_statuses' }))
    const msg = await errPromise as { reason: string }
    expect(msg.reason).toBe('admin required')
    ws.close()
  }, 8000)
})

// ---------------------------------------------------------------------------
// Per-user connection cap
// ---------------------------------------------------------------------------

describe('per-user connection cap (max 10)', () => {
  let handle: ServerHandle
  let db: Database.Database

  beforeEach(async () => {
    vi.stubEnv('WS_SECRET', 'capsecret')
    db = makeDb()
    db.prepare(`INSERT INTO projects (id, name) VALUES ('proj-a','A')`).run()
    initUserStore(db)
    handle = await startFullServer(db)
  })
  afterEach(async () => { await handle.stop(); vi.unstubAllEnvs() })

  it('11th connection from the same user is rejected with close code 4429', async () => {
    const user = createUser({ email: 'heavy@t.com', name: 'Heavy', global_role: 'member' })
    grantProjectMembership({ project_id: 'proj-a', user_id: user.id, role: 'viewer' })

    const sockets: WebSocket[] = []

    for (let i = 0; i < 10; i++) {
      const { ticket } = issueWsTicket(user.id)
      const { ws, waitFor } = await wsConnect(handle.port)
      const regPromise = waitFor('registered')
      ws.send(JSON.stringify({ type: 'register', clientId: `browser-heavy-${i}`, userTicket: ticket }))
      await regPromise
      sockets.push(ws)
    }

    const { ticket } = issueWsTicket(user.id)
    const { ws: ws11, waitFor: w11 } = await wsConnect(handle.port)
    const errPromise = w11('error')
    ws11.send(JSON.stringify({ type: 'register', clientId: 'browser-heavy-10', userTicket: ticket }))
    await errPromise
    const closeCode = await new Promise<number>(res => ws11.on('close', (code) => res(code)))
    expect(closeCode).toBe(4429)

    for (const s of sockets) s.close()
  }, 20000)
})
