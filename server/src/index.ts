import './env.js' // Must be first -- loads .env before any other module reads process.env
import express, { type Request, type Response, type NextFunction } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, closeAllDatabases, getServerDb } from './db.js'
import { initUserStore } from './users.js'
import { authenticate, scopeProjects, mountAuthRoutes, ensureAuthBootstrap } from './auth.js'
import routes from './routes.js'
import pawsRoutes from './paws-routes.js'
import memoryRoutes from './memory-routes.js'
import brokerRoutes from './broker-routes/index.js'
import { mountUsersRoutes } from './users-routes.js'
import { setupWebSocket } from './ws.js'
import { logger } from './logger.js'
import { runMetricsCollection } from './metrics-collector.js'
import { pruneKillSwitchLog } from './system-state.js'
import { resolveKillSwitchLogRetentionDays } from './env-config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = parseInt(process.env.PORT ?? '3000', 10)
const ALLOW_UNAUTHENTICATED_DASHBOARD =
  process.env.NODE_ENV !== 'production' && process.env.ALLOW_UNAUTHENTICATED_DASHBOARD === '1'

function assertDashboardAuthConfig(): void {
  const hasDashboardToken = Boolean(process.env.DASHBOARD_API_TOKEN?.trim())
  if (hasDashboardToken || ALLOW_UNAUTHENTICATED_DASHBOARD) return
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DASHBOARD_API_TOKEN must be set in production')
  }
  logger.warn('Dashboard API token is not set. API access is blocked until DASHBOARD_API_TOKEN is configured or ALLOW_UNAUTHENTICATED_DASHBOARD=1 is set for local dev.')
}

function isPublicApiRoute(req: express.Request): boolean {
  // OAuth callback requests come from Google, not from an already-authenticated
  // browser session, so they cannot present the dashboard token cookie/header.
  // The signed OAuth state token is the real protection for this route.
  if (req.method === 'GET' && /^\/integrations\/[^/]+\/callback$/.test(req.path)) {
    return true
  }
  return false
}

const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map(s => s.trim())

const app = express()
app.use(cors({
  origin: CORS_ORIGINS,
}))
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://unpkg.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'https://unpkg.com', 'https://*.tile.openstreetmap.org'],
      'connect-src': ["'self'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
      'upgrade-insecure-requests': null, // Dashboard served over HTTP on Tailscale; mobile Safari blocks all resources when this is set
    }
  }
}))
app.use(express.json({ limit: '1mb' }))

// Rate limiting for /api/v1. Two tiers:
//   - general: 300 requests/minute per IP
//   - task runs: 30 requests/minute per IP (each spawns a Claude agent)
// Trust proxy for correct IP when behind nginx/cloudflare.
app.set('trust proxy', 1)
// Per-user rate limit keys: identified users get a stable per-user bucket;
// pre-auth requests (e.g. OAuth callbacks) fall back to per-IP. This keeps
// one noisy user from exhausting another's budget on shared Tailscale IPs.
const userOrIpKey = (req: Request): string => {
  const uid = req.user?.id
  return uid ? `u:${uid}` : ipKeyGenerator(req.ip ?? 'unknown')
}
const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many requests, slow down.' },
})
const taskRunLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many task runs, slow down.' },
})

// Mount auth routes BEFORE the authenticate middleware so that
// POST /api/v1/auth/login does not require an existing token.
// Login has its own per-IP 10/min limiter inside mountAuthRoutes.
mountAuthRoutes(app)

// API authentication + project scoping for all /api/v1 routes.
// OAuth callbacks are public (signed state provides their own security).
app.use('/api/v1', (req, res, next) => {
  if (isPublicApiRoute(req)) {
    next()
    return
  }
  authenticate(req, res, next)
})
app.use('/api/v1', (req, res, next) => {
  if (isPublicApiRoute(req)) {
    next()
    return
  }
  // scopeProjects requires req.user to be set by authenticate above.
  // If authenticate returned a 401, this middleware is never reached.
  scopeProjects(req, res, next)
})

// Rate limiters apply AFTER authenticate so userOrIpKey can read req.user.id.
// Public bypass routes (OAuth callbacks) still get IP-based limiting.
app.use('/api/v1/tasks/:id/run', taskRunLimiter)
app.use('/api/v1', generalApiLimiter)

// Serve static dashboard files (no-cache for JS/CSS so deploys take effect immediately)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate')
    }
  },
}))

// API routes
app.use('/api/v1', routes)
app.use(pawsRoutes)
app.use(brokerRoutes)
app.use('/api/v1/memory', memoryRoutes)
mountUsersRoutes(app)

// Global error handler -- must be last app.use()
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, 'Unhandled route error')
  res.status(500).json({ error: 'Internal server error' })
})

const server = createServer(app)

// Init database, then user store and auth bootstrap (order matters).
assertDashboardAuthConfig()
const serverDb = initDatabase()
initUserStore(serverDb)
ensureAuthBootstrap(serverDb)

// Attach WebSocket
setupWebSocket(server)

if (process.env.NODE_ENV === 'production' && !process.env.DASHBOARD_JWT_SECRET) {
  // OAuth state JWTs are signed with this secret. Without it, every OAuth
  // reconnect returns 503 mid-flow — silent degradation that only surfaces
  // weeks later when someone tries to reconnect an integration. Fail loud.
  logger.error('CRITICAL: DASHBOARD_JWT_SECRET not set in production -- OAuth integration flows will 503. Generate with: openssl rand -hex 32')
  process.exit(1)
}
if (process.env.NODE_ENV === 'production' && !process.env.WS_SECRET) {
  logger.error('CRITICAL: WS_SECRET not set in production -- WebSocket auth is disabled')
  process.exit(1)
}
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_UNAUTHENTICATED_DASHBOARD === '1') {
  // Safety guard: the dev bypass grants instant admin. If someone ever copies
  // a dev .env to production, refuse to boot rather than silently allowing
  // unauthenticated admin access.
  logger.error('CRITICAL: ALLOW_UNAUTHENTICATED_DASHBOARD=1 is set in production -- refusing to boot. Unset the variable before starting.')
  process.exit(1)
}
if (!process.env.WS_SECRET) {
  logger.warn('WS_SECRET not set -- WebSocket connections will not require HMAC auth')
}

server.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT }, 'ClaudePaw server started')
  logger.info(`Dashboard: http://localhost:${PORT}`)
  logger.info(`API: http://localhost:${PORT}/api/v1`)
  logger.info(`WebSocket: ws://localhost:${PORT}`)

  // Collect metrics once per day at ~5am local time. Avoids YouTube API quota issues.
  function msUntilNext5am(): number {
    const now = new Date()
    const next = new Date(now)
    next.setHours(5, 0, 0, 0)
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1)
    }
    return next.getTime() - now.getTime()
  }
  function scheduleDailyMetrics(): void {
    const wait = msUntilNext5am()
    const hours = Math.round(wait / 3600000 * 10) / 10
    logger.info({ hoursUntilNextRun: hours }, 'Next metrics collection scheduled for ~5am local')
    setTimeout(() => {
      runMetricsCollection()
        .then(s => logger.info(s))
        .catch(e => logger.error({ err: e }, 'Daily metrics collection failed'))
        .finally(() => scheduleDailyMetrics())
    }, wait)
  }
  scheduleDailyMetrics()

  // Phase 6 Task 5 -- kill_switch_log retention.  Drops rows older than
  // KILL_SWITCH_LOG_RETENTION_DAYS (default 180).  Fires once on startup,
  // then every 24 hours.
  //
  // Phase 7 Task 8 -- retention window is configurable via the
  // KILL_SWITCH_LOG_RETENTION_DAYS env var.  Non-numeric, non-finite,
  // non-integer, or non-positive values fall back to the 180-day default
  // with a warning logged so a typo in the env does not silently disable
  // retention.  The resolved value is logged at info on startup so ops
  // can confirm which window is active without reading the code.
  const KILL_SWITCH_LOG_RETENTION_DAYS = resolveKillSwitchLogRetentionDays(
    process.env.KILL_SWITCH_LOG_RETENTION_DAYS,
    logger,
  )
  logger.info(
    { retentionDays: KILL_SWITCH_LOG_RETENTION_DAYS },
    'kill_switch_log: retention configured',
  )
  const KILL_SWITCH_LOG_RETENTION_MS = KILL_SWITCH_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const KILL_SWITCH_LOG_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000
  function runKillSwitchLogPrune(): void {
    try {
      const cutoffMs = Date.now() - KILL_SWITCH_LOG_RETENTION_MS
      const deleted = pruneKillSwitchLog(getServerDb(), cutoffMs)
      logger.info({ cutoffMs, deleted }, 'kill_switch_log: prune complete')
    } catch (err) {
      logger.warn({ err }, 'kill_switch_log: prune failed')
    }
  }
  runKillSwitchLogPrune()
  setInterval(runKillSwitchLogPrune, KILL_SWITCH_LOG_PRUNE_INTERVAL_MS).unref()
})

// Graceful shutdown
function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down...')
  setTimeout(() => {
    logger.error('Forced shutdown after timeout')
    process.exit(1)
  }, 10000).unref()
  server.close(() => {
    closeAllDatabases()
    process.exit(0)
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
