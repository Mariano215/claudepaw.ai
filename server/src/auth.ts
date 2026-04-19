import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { Express } from 'express'
import type Database from 'better-sqlite3'
import rateLimit from 'express-rate-limit'
import {
  hashToken,
  roleAtLeast,
  resolveUserByTokenHash,
  getUserById,
  listUsers,
  createUser,
  insertTokenHash,
  getUserProjectIds,
  getUserProjectRole,
  grantProjectMembership,
  listProjectMemberships,
  type ProjectRole,
} from './users.js'
import { getBotDbWrite } from './db.js'
import { logger } from './logger.js'

// ---------------------------------------------------------------------------
// Type augmentation
// ---------------------------------------------------------------------------

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthenticatedUser
    scope?: ProjectScope
  }
}

export interface AuthenticatedUser {
  id: number
  email: string
  name: string
  global_role: 'admin' | 'member' | 'bot'
  isAdmin: boolean
}

export interface ProjectScope {
  requestedProjectId: string | null
  allowedProjectIds: string[] | null
  isAdmin: boolean
}

// ---------------------------------------------------------------------------
// Bootstrap: seed admin user from legacy DASHBOARD_API_TOKEN env var
// ---------------------------------------------------------------------------

/**
 * Seed a bootstrap admin user from DASHBOARD_API_TOKEN env var.
 * Idempotent: does nothing when users already exist.
 * The optional botDb parameter allows tests to inject an in-memory DB; in
 * production it defaults to getBotDbWrite() (the real bot database).
 */
export function ensureAuthBootstrap(botDb?: Database.Database): void {
  const existing = listUsers()

  // Seed the admin user only when the users table is completely empty.
  if (existing.length === 0) {
    const rawToken = process.env.DASHBOARD_API_TOKEN?.trim()
    if (!rawToken) {
      logger.warn('Auth bootstrap: no users exist and DASHBOARD_API_TOKEN is not set. Dashboard will require a token to be created manually.')
    } else {
      const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() || 'admin@claudepaw.local'
      const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Admin'

      const user = createUser({ email, name, global_role: 'admin' })

      // Hash the existing raw env token and store it so that any cookie already in
      // the browser (containing the raw token value) continues to work transparently
      // after this migration. Uses insertTokenHash to stay within the users store
      // rather than reaching into the DB directly.
      const hash = createHash('sha256').update(rawToken).digest('hex')
      insertTokenHash({
        user_id: user.id,
        token_hash: hash,
        label: 'bootstrap from DASHBOARD_API_TOKEN',
      })

      // Grant owner membership on every project that already exists in the bot DB.
      // getBotDbWrite() is only used here to enumerate project IDs; membership rows
      // themselves go through grantProjectMembership (users store).
      const bdb = botDb ?? getBotDbWrite()
      const projectRows = bdb
        ? (bdb.prepare(`SELECT id FROM projects`).all() as Array<{ id: string }>)
        : []
      for (const { id } of projectRows) {
        grantProjectMembership({
          project_id: id,
          user_id: user.id,
          role: 'owner',
          granted_by_user_id: null,
        })
      }

      logger.info(
        { userId: user.id, projectCount: projectRows.length },
        `Auth bootstrap: seeded admin user ${user.id} from DASHBOARD_API_TOKEN`,
      )
    }
  }

  // Seed the bot user from BOT_API_TOKEN. This runs on every startup so the
  // bot user is created whenever the token is first set, even if other users
  // already exist (e.g. after an upgrade to an existing deployment).
  const botToken = process.env.BOT_API_TOKEN?.trim()
  if (botToken) {
    const existingBot = listUsers().find(u => u.global_role === 'bot')
    if (!existingBot) {
      const botEmail = process.env.BOT_USER_EMAIL?.trim() || 'bot@claudepaw.local'
      const botName = process.env.BOT_USER_NAME?.trim() || 'ClaudePaw Bot'
      const botUser = createUser({ email: botEmail, name: botName, global_role: 'bot' })
      const botHash = createHash('sha256').update(botToken).digest('hex')
      insertTokenHash({
        user_id: botUser.id,
        token_hash: botHash,
        label: 'bootstrap from BOT_API_TOKEN',
      })
      // Bot user has zero project memberships -- the bot bypass IS its identity.
      logger.info({ botUid: botUser.id }, 'Auth bootstrap: seeded bot user from BOT_API_TOKEN')
    }
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const COOKIE_NAME = 'dashboard_api_token'
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000 // 1 year in ms

function readCookieValue(req: Request, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const chunk of raw.split(';')) {
    const [key, ...rest] = chunk.trim().split('=')
    if (key !== name) continue
    return decodeURIComponent(rest.join('='))
  }
  return null
}

// ---------------------------------------------------------------------------
// Middleware: authenticate
// ---------------------------------------------------------------------------

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  // Dev bypass: ALLOW_UNAUTHENTICATED_DASHBOARD=1 outside production
  const allowUnauthenticated =
    process.env.NODE_ENV !== 'production' &&
    process.env.ALLOW_UNAUTHENTICATED_DASHBOARD === '1'

  if (allowUnauthenticated) {
    req.user = {
      id: 0,
      email: 'dev@claudepaw.local',
      name: 'Dev Admin',
      global_role: 'admin',
      isAdmin: true,
    }
    next()
    return
  }

  // Extract token: header takes precedence over cookie.
  const headerVal = req.headers['x-dashboard-token']
  const headerToken = typeof headerVal === 'string'
    ? headerVal
    : Array.isArray(headerVal) ? headerVal[0] : undefined
  const cookieToken = readCookieValue(req, COOKIE_NAME) ?? undefined

  const rawToken = headerToken || cookieToken
  if (!rawToken) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const hash = hashToken(rawToken)
  const user = resolveUserByTokenHash(hash)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  req.user = {
    id: user.id,
    email: user.email,
    name: user.name,
    global_role: user.global_role,
    isAdmin: user.global_role === 'admin',
  }
  next()
}

// ---------------------------------------------------------------------------
// Middleware: scopeProjects
// ---------------------------------------------------------------------------

export function scopeProjects(req: Request, res: Response, next: NextFunction): void {
  const user = req.user!
  const raw = req.query.project_id
  const rawStr = typeof raw === 'string' ? raw.trim() : null
  const requestedProjectId =
    !rawStr || rawStr === '' || rawStr === 'all' ? null : rawStr

  if (user.isAdmin) {
    req.scope = { requestedProjectId, allowedProjectIds: null, isAdmin: true }
    next()
    return
  }

  const allowed = getUserProjectIds(user.id)
  if (requestedProjectId && !allowed.includes(requestedProjectId)) {
    // 404 -- do not leak project existence to unauthorized members
    res.status(404).json({ error: 'Not found' })
    return
  }

  req.scope = { requestedProjectId, allowedProjectIds: allowed, isAdmin: false }
  next()
}

// ---------------------------------------------------------------------------
// Middleware: requireAdmin
// ---------------------------------------------------------------------------

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.isAdmin) {
    next()
    return
  }
  res.status(403).json({ error: 'Admin required' })
}

// ---------------------------------------------------------------------------
// Middleware: requireBotOrAdmin
// ---------------------------------------------------------------------------

/**
 * Allow only requests from users with global_role 'bot' or 'admin'.
 * Used on bot-internal callback endpoints (chat results, research updates,
 * paws sync) that should never be reachable by human members.
 */
export function requireBotOrAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = req.user?.global_role
  if (role === 'bot' || role === 'admin') {
    next()
    return
  }
  res.status(403).json({ error: 'bot or admin required' })
}

// ---------------------------------------------------------------------------
// Middleware factory: requireProjectRead
// ---------------------------------------------------------------------------

export function requireProjectRead(pidParam = 'id'): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.user?.isAdmin) {
      next()
      return
    }
    const pidRaw = req.params[pidParam]
    const pid = typeof pidRaw === 'string' ? pidRaw : undefined
    const allowed = req.scope?.allowedProjectIds ?? []
    if (!pid || !allowed.includes(pid)) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    next()
  }
}

// ---------------------------------------------------------------------------
// Middleware factory: requireProjectRole
// ---------------------------------------------------------------------------

export function requireProjectRole(
  minRole: ProjectRole,
  pidResolver?: (req: Request) => string | null,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.user?.isAdmin) {
      next()
      return
    }

    const defaultResolver = (r: Request): string | null => {
      const fromParamsRaw = r.params.id
      const fromParams = typeof fromParamsRaw === 'string' ? fromParamsRaw : null
      const fromQuery = typeof r.query.project_id === 'string' ? r.query.project_id : null
      const fromBody = typeof r.body?.project_id === 'string' ? r.body.project_id : null
      return fromParams ?? fromQuery ?? fromBody ?? null
    }

    const resolve = pidResolver ?? defaultResolver
    const pid = resolve(req)

    if (!pid) {
      res.status(400).json({ error: 'project_id required' })
      return
    }

    const userId = req.user!.id
    const role = getUserProjectRole(userId, pid)
    if (!roleAtLeast(role, minRole)) {
      res.status(403).json({ error: 'Insufficient project role' })
      return
    }

    next()
  }
}

// ---------------------------------------------------------------------------
// WS ticket store
// ---------------------------------------------------------------------------

const WS_TICKET_TTL_MS = 60_000

// Consumed nonces: maps nonce -> expiry_ms. Pruned lazily on each issue/verify.
const consumedNonces = new Map<string, number>()

function pruneNonces(): void {
  const now = Date.now()
  for (const [nonce, exp] of consumedNonces) {
    if (now > exp) consumedNonces.delete(nonce)
  }
}

export interface WsTicket {
  ticket: string
  expires_at: number
}

/**
 * Issue a single-use WS ticket for the given user id.
 * Format: `{user_id}.{issued_at_ms}.{nonce}.{hmac}`
 * HMAC covers `{user_id}.{issued_at_ms}.{nonce}` with WS_SECRET.
 * Falls back gracefully in dev when WS_SECRET is absent (returns unsigned ticket
 * with nonce="dev" so tests can run without env vars).
 */
export function issueWsTicket(userId: number): WsTicket {
  const issuedAt = Date.now()
  const nonce = randomBytes(16).toString('hex')
  const wsSecret = process.env.WS_SECRET
  if (!wsSecret && process.env.NODE_ENV === 'production') {
    throw new Error('WS_SECRET required in production')
  }
  const secret = wsSecret ?? ''
  const payload = `${userId}.${issuedAt}.${nonce}`
  const hmac = createHmac('sha256', secret).update(payload).digest('hex')
  const ticket = `${payload}.${hmac}`
  return { ticket, expires_at: issuedAt + WS_TICKET_TTL_MS }
}

export interface VerifiedTicket {
  userId: number
  nonce: string
}

/**
 * Verify a WS ticket. Returns the verified user id + nonce on success.
 * Throws a descriptive Error on any failure.
 */
export function verifyWsTicket(ticket: string): VerifiedTicket {
  const parts = ticket.split('.')
  if (parts.length !== 4) throw new Error('malformed ticket')
  const [userIdStr, issuedAtStr, nonce, hmac] = parts as [string, string, string, string]

  const userId = Number(userIdStr)
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('invalid user_id in ticket')

  const issuedAt = Number(issuedAtStr)
  if (!Number.isFinite(issuedAt)) throw new Error('invalid issued_at in ticket')

  // TTL check
  if (Date.now() - issuedAt >= WS_TICKET_TTL_MS) throw new Error('ticket expired')

  // HMAC check
  const wsSecret = process.env.WS_SECRET
  if (!wsSecret && process.env.NODE_ENV === 'production') {
    throw new Error('WS_SECRET required in production')
  }
  const secret = wsSecret ?? ''
  const payload = `${userId}.${issuedAt}.${nonce}`
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  const hmacBuf = Buffer.from(hmac, 'hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  if (hmacBuf.length !== expectedBuf.length) throw new Error('invalid ticket hmac')
  if (!timingSafeEqual(hmacBuf, expectedBuf)) throw new Error('invalid ticket hmac')

  // Replay check
  pruneNonces()
  if (consumedNonces.has(nonce)) throw new Error('ticket already used')
  consumedNonces.set(nonce, issuedAt + WS_TICKET_TTL_MS)

  return { userId, nonce }
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts, slow down.' },
})

export function mountAuthRoutes(app: Express): void {
  // POST /api/v1/auth/login -- does NOT require authenticate (this IS the auth)
  app.post('/api/v1/auth/login', loginLimiter, (req: Request, res: Response): void => {
    const { token: rawToken } = req.body as { token?: unknown }

    if (typeof rawToken !== 'string' || !rawToken.trim()) {
      res.status(400).json({ error: 'token is required' })
      return
    }

    const hash = hashToken(rawToken.trim())
    const user = resolveUserByTokenHash(hash)
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    res.cookie(COOKIE_NAME, rawToken.trim(), {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      maxAge: COOKIE_MAX_AGE_MS,
      path: '/',
    })

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        global_role: user.global_role,
      },
    })
  })

  // POST /api/v1/auth/logout -- requires authenticate (applied at route level)
  app.post('/api/v1/auth/logout', authenticate, (_req: Request, res: Response): void => {
    res.clearCookie(COOKIE_NAME, { path: '/' })
    res.json({})
  })

  // GET /api/v1/auth/me -- requires authenticate (applied at route level)
  app.get('/api/v1/auth/me', authenticate, (req: Request, res: Response): void => {
    const user = req.user!
    const memberships = listProjectMemberships(user.id).map(m => ({
      project_id: m.project_id,
      role: m.role,
    }))
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        global_role: user.global_role,
      },
      memberships,
    })
  })

  // GET /api/v1/auth/ws-ticket -- returns a short-lived single-use WS ticket
  app.get('/api/v1/auth/ws-ticket', authenticate, (req: Request, res: Response): void => {
    const user = req.user!
    // Confirm the user still exists in the store before issuing
    const dbUser = getUserById(user.id)
    if (!dbUser) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const wsTicket = issueWsTicket(user.id)
    res.json(wsTicket)
  })
}
