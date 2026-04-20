import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express'
import { mountIntegrationsRoutes } from './integrations/routes.js'
import systemStateRoutes from './system-state-routes.js'
import costGateRoutes from './cost-gate-routes.js'
import { writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHmac, createDecipheriv } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'
import { quotaFetch, QuotaCooldownError, getQuotaStatus, clearCooldown } from './quota.js'
import { google } from 'googleapis'
import jwt from 'jsonwebtoken'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
import {
  getAllAgents, getAgent, updateAgentStatus, upsertAgent,
  sendMessage, getMessagesForAgent, markDelivered, markCompleted, getRecentMessages,
  addFeedItem, getRecentFeed,
  recordMetric, getMetrics,
  getDb, getBotDb, getBotDbWrite,
  upsertSecurityFinding, getSecurityFindings, updateSecurityFindingStatus,
  recordSecurityScan, getSecurityScans,
  upsertSecurityScore, getSecurityScore,
  getSecurityAutoFixes, recordSecurityAutoFix,
  queryChatMessages,
  getAllScheduledTasks, getScheduledTask, updateScheduledTaskStatus, createScheduledTask, updateScheduledTask, deleteScheduledTask,
  getResearchItems, getResearchItem, upsertResearchItem, updateResearchItemStatus, updateResearchInvestigatedAt, deleteResearchItem, getResearchStats,
  getLatestBoardMeeting, getBoardMeetingHistory, getBoardMeeting,
  createBoardMeeting, createBoardDecision,
  getBoardDecisions, updateBoardDecisionStatus, getBoardStats,
  getCommsLog, getActiveConnections, getChannelLog,
  getAllProjectsWithSettings, getProjectById, getProjectSettingsById,
  createProjectInDb, updateProjectInDb, deleteProjectFromDb, upsertProjectSettingsInDb,
  getAllPlugins, getPluginById, updatePluginEnabled,
  type FindingsFilter,
  type ResearchFilter,
  type CommsFilter,
  getAllWebhooks,
  createWebhookInBotDb,
  deleteWebhookFromBotDb,
  toggleWebhookInBotDb,
  getRecentWebhookDeliveries,
  getProjectOverview,
  getProjectIntegrations, getAllProjectIntegrations, upsertProjectIntegration, deleteProjectIntegration,
  getMetricHealthForProject, getDegradedMetricHealth,
  seedProjectAgents, deleteAgent,
  setOAuthCredential, getOAuthServiceCredentials, listOAuthServices, deleteOAuthService,
  listProjectCredentials, listAllProjectCredentials, setProjectCredential, deleteProjectCredentialKey, deleteProjectCredentialService,
  insertChatEvent,
} from './db.js'
import { notifyAgentMessage, broadcastFeedUpdate, broadcastToMac, getConnectedClients, getBotHealthSnapshots, broadcastTestUpdate, broadcastActionItemUpdate, broadcastActionItemChatResult, broadcastChatResponse, broadcastResearchChatResult, broadcastResearchInvestigationComplete, getBotGitHash } from './ws.js'
import { logger } from './logger.js'
import { getUpdateStatus, type UpdateStatus } from './system-update.js'
import {
  requireAdmin,
  requireBotOrAdmin,
  requireProjectRead,
  requireProjectRole,
  type ProjectScope,
} from './auth.js'
import { getUserProjectRole, roleAtLeast } from './users.js'

const PROJECT_ROOT = process.env.PROJECT_ROOT
if (!PROJECT_ROOT) {
  logger.warn('PROJECT_ROOT not set -- agent file operations will fail')
}
import { getCostSummary, getLineItems, upsertLineItem, updateLineItem, deleteLineItem } from './costs.js'
import {
  getChatHistory,
  saveChatMessage,
  makeChatMessage,
  buildAgentPrompt,
  type ActionItemContext,
} from './action-plan-chat.js'
import {
  getChatHistory as getResearchChatHistory,
  saveChatMessage as saveResearchChatMessage,
  makeChatMessage as makeResearchChatMessage,
  buildScoutContext,
  type ResearchItemContext,
} from './research-chat.js'

// 5-minute cache for GitHub API responses (rate limit: 60 req/hr unauthed)
let updateStatusCache: { data: UpdateStatus; cachedAt: number } | null = null
const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Memory V2 dual-write (chat_messages)
//
// Writes dashboard-originated chat turns (research + action-plan) to the
// bot DB's chat_messages table so Memory V2 layers (FTS, Layer 5 history)
// see them. We cannot import ../../src/chat/messages.js here because the
// server tsconfig has rootDir=src, so the INSERT is issued inline against
// the shared claudepaw.db via getBotDbWrite().
//
// The Memory V2 env flag is read via process.env rather than importing
// ../../src/config.js for the same rootDir reason. Heuristic extraction
// is NOT run inline in the dashboard path (depends on src/db.ts init which
// only happens in the bot process); it will pick these messages up via the
// batch extractor on the bot side.
// ---------------------------------------------------------------------------

const MEMORY_V2_ENABLED = (process.env.MEMORY_V2_ENABLED ?? 'true') !== 'false'

// Cache whether chat_messages exists in the bot DB. The bot process creates
// the table on boot; if the dashboard starts first or the bot schema lags
// behind we silently skip the dual-write rather than spamming errors.
let memoryV2TableReady: boolean | null = null
function isChatMessagesReady(bdb: ReturnType<typeof getBotDbWrite>): boolean {
  if (!bdb) return false
  if (memoryV2TableReady !== null) return memoryV2TableReady
  try {
    const row = bdb.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages'`,
    ).get()
    memoryV2TableReady = Boolean(row)
  } catch {
    memoryV2TableReady = false
  }
  return memoryV2TableReady
}

function saveV2ChatMessage(input: {
  chatId: string
  projectId: string
  userId: string | null
  role: 'user' | 'assistant'
  content: string
}): number | null {
  const bdb = getBotDbWrite()
  if (!bdb) return null
  if (!isChatMessagesReady(bdb)) return null
  try {
    const result = bdb.prepare(`
      INSERT INTO chat_messages (chat_id, project_id, user_id, role, content, tool_calls, token_count, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(input.chatId, input.projectId, input.userId, input.role, input.content, Date.now())
    return Number(result.lastInsertRowid)
  } catch (err) {
    logger.warn({ err, chatId: input.chatId }, 'memory-v2 chat_messages insert failed')
    return null
  }
}

// ---------------------------------------------------------------------------
// Action items (read/write against bot DB via getBotDbWrite)
// ---------------------------------------------------------------------------

type ActionItemStatus =
  | 'proposed' | 'approved' | 'in_progress' | 'blocked'
  | 'paused' | 'completed' | 'rejected' | 'archived'

type ActionItemPriority = 'low' | 'medium' | 'high' | 'critical'

interface ActionItemRow {
  id: string
  project_id: string
  title: string
  description: string | null
  status: ActionItemStatus
  priority: ActionItemPriority
  source: string
  proposed_by: string
  assigned_to: string | null
  executable_by_agent: 0 | 1
  parent_id: string | null
  target_date: number | null
  created_at: number
  updated_at: number
  completed_at: number | null
  archived_at: number | null
  last_run_at: number | null
  last_run_result: string | null
  last_run_session: string | null
}

interface ActionItemCommentRow {
  id: string
  item_id: string
  author: string
  body: string
  created_at: number
}

interface ActionItemEventRow {
  id: string
  item_id: string
  actor: string
  event_type: string
  old_value: string | null
  new_value: string | null
  created_at: number
}

const AP_TRANSITIONS: Record<ActionItemStatus, ActionItemStatus[]> = {
  proposed:    ['approved', 'rejected', 'paused', 'archived'],
  approved:    ['in_progress', 'completed', 'paused', 'blocked', 'archived'],
  in_progress: ['completed', 'blocked', 'paused', 'archived'],
  blocked:     ['approved', 'in_progress', 'paused', 'rejected', 'archived'],
  paused:      ['approved', 'rejected', 'archived'],
  completed:   ['archived'],
  rejected:    ['archived'],
  archived:    [],
}

function apCanTransition(from: ActionItemStatus, to: ActionItemStatus): boolean {
  return AP_TRANSITIONS[from]?.includes(to) ?? false
}

const router = Router()

const EXECUTION_PROVIDERS = new Set(['claude_desktop', 'codex_local', 'anthropic_api', 'openai_api', 'openrouter_api', 'ollama', 'lm_studio'])
const FALLBACK_POLICIES = new Set(['disabled', 'enabled'])
const MODEL_TIERS = new Set(['cheap', 'balanced', 'premium'])
const AGENT_PROVIDER_MODES = new Set(['inherit', 'claude_desktop', 'codex_local', 'anthropic_api', 'openai_api', 'openrouter_api', 'ollama', 'lm_studio'])

function isModelCompatibleWithProvider(provider: string, model: string): boolean {
  const normalized = model.trim().toLowerCase()
  if (!normalized) return true
  if (provider === 'claude_desktop') return false
  if (provider === 'anthropic_api') return normalized.startsWith('claude-')
  if (provider === 'codex_local' || provider === 'openai_api') return /^(gpt-|o\d|codex)/.test(normalized)
  return true
}

function normalizeFallbackPolicy(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (value === 'disabled') return 'disabled'
  if (value === 'enabled' || value === 'auto_on_error' || value === 'auto_on_quota') return 'enabled'
  if (value === 'manual_only') return 'disabled'
  return value
}

/** Extract a route param as a plain string (Express 5 types params as string | string[]) */
function param(req: Request, name: string): string {
  const val = req.params[name]
  return Array.isArray(val) ? val[0] : val
}

/** Resolved project scope from auth middleware. */
export interface ResolvedScope {
  requestedProjectId: string | null
  allowedProjectIds: string[] | null
  isAdmin: boolean
}

export function resolveProjectScope(req: Request): ResolvedScope {
  if (!req.scope) {
    logger.error('resolveProjectScope called without scopeProjects middleware -- this is a bug')
    throw new Error('scope not resolved')
  }
  return req.scope
}

/**
 * Returns a middleware that gates a resource-specific route by project role.
 *
 * `lookupProjectId` receives the route :id param and returns the resource's
 * project_id, or null when the resource does not exist. A null return produces
 * a 404 (resource not found) rather than the 400 ("project_id required") that
 * `requireProjectRole` would emit -- because the resource simply doesn't exist.
 *
 * Admin users bypass the project role check entirely (lookupProjectId is not
 * called for admins).
 */
export function requireProjectRoleForResource(
  minRole: Parameters<typeof requireProjectRole>[0],
  lookupProjectId: (id: string) => string | null,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Admin bypass -- no lookup needed.
    if (req.user?.isAdmin) {
      next()
      return
    }

    const rawId = req.params.id
    const id = typeof rawId === 'string' ? rawId : (Array.isArray(rawId) ? rawId[0] : undefined)
    if (!id) {
      res.status(400).json({ error: 'id required' })
      return
    }

    const pid = lookupProjectId(id)
    if (pid === null) {
      // Resource does not exist (or belongs to no project) -- 404, not 400.
      res.status(404).json({ error: 'Not found' })
      return
    }

    // Role check. We do NOT delegate to requireProjectRole here because we want
    // to distinguish "not a member" (should 404 to hide resource existence)
    // from "member but insufficient role" (403 is fine because the caller
    // already knows the resource exists via a prior list/read). requireProjectRole
    // collapses both cases to 403 for its caller-supplied-project-id use case.
    const userId = req.user!.id
    const role = getUserProjectRole(userId, pid)
    if (role === null) {
      // Non-member: 404 to avoid leaking resource existence to outsiders.
      res.status(404).json({ error: 'Not found' })
      return
    }
    if (!roleAtLeast(role, minRole)) {
      res.status(403).json({ error: 'Insufficient project role' })
      return
    }

    next()
  }
}

/** Validate a project_id exists in the DB.
 * Keep in sync with projectExistsInStore() in users.ts -- both must validate against the same projects table shape.
 */
function isValidProjectId(pid: string): boolean {
  return !!getProjectById(pid)
}

function sanitizeWebhookForResponse(wh: {
  id: string
  project_id: string
  event_type: string
  target_url: string
  active: number
  created_at: number
  secret?: string
}) {
  return {
    id: wh.id,
    project_id: wh.project_id,
    event_type: wh.event_type,
    target_url: wh.target_url,
    active: wh.active,
    created_at: wh.created_at,
    has_secret: Boolean(wh.secret),
  }
}

function broadcastCredentialSync(projectId: string, service: string, key: string, value?: string): void {
  const payload: Record<string, unknown> = {
    type: 'project_credential_sync',
    project_id: projectId,
    service,
    key,
    updated_at: Date.now(),
  }
  if (value !== undefined) {
    payload.value = value
  }
  broadcastToMac(payload)
}

function broadcastCredentialDelete(projectId: string, service: string, key?: string): void {
  broadcastToMac({
    type: 'project_credential_delete',
    project_id: projectId,
    service,
    ...(key ? { key } : {}),
  })
}

type IntegrationSummaryStatus = 'connected' | 'configured' | 'incomplete' | 'disconnected'

interface IntegrationSummaryRow {
  service: string
  base_service: string
  account?: string
  status: IntegrationSummaryStatus
  key_count: number
  configured_keys: string[]
  missing_keys: string[]
  scopes?: string[]
  updated_at: number
}

const REQUIRED_SERVICE_KEYS: Record<string, string[]> = {
  twitter: ['api_key', 'api_secret', 'access_token', 'access_secret'],
  linkedin: ['access_token'],
  meta: ['page_access_token', 'page_id'],
  telegram: ['bot_token'],
  wordpress: ['fop_url', 'fop_user', 'fop_app_password'],
  newsletter: ['client_key', 'client_secret'],
  youtube: ['channel_id'],
  google: ['access_token', 'refresh_token'],
  shopify: ['store_url', 'access_token'],
  imap: ['host', 'port', 'password'],
}

function summarizeService(
  projectId: string,
  service: string,
  keys: Array<{ key: string; updated_at: number }>,
): IntegrationSummaryRow {
  const colonIdx = service.indexOf(':')
  const baseService = colonIdx === -1 ? service : service.slice(0, colonIdx)
  const account = colonIdx === -1 ? undefined : service.slice(colonIdx + 1)
  const configuredKeys = keys.map((k) => k.key)
  const updatedAt = keys.reduce((max, key) => Math.max(max, key.updated_at || 0), 0)

  if (baseService === 'google' && account) {
    const creds = getOAuthServiceCredentials(projectId, service)
    const status = (creds.status as IntegrationSummaryStatus | undefined) === 'connected'
      ? 'connected'
      : 'disconnected'
    return {
      service,
      base_service: baseService,
      account,
      status,
      key_count: configuredKeys.length,
      configured_keys: configuredKeys,
      missing_keys: [],
      scopes: creds.scopes ? creds.scopes.split(' ').filter(Boolean) : [],
      updated_at: updatedAt,
    }
  }

  const requiredKeys = REQUIRED_SERVICE_KEYS[baseService] || []
  const missingKeys = requiredKeys.filter((requiredKey) => !configuredKeys.includes(requiredKey))
  const status: IntegrationSummaryStatus =
    requiredKeys.length === 0
      ? 'configured'
      : missingKeys.length === 0
        ? 'configured'
        : configuredKeys.length > 0
          ? 'incomplete'
          : 'disconnected'

  return {
    service,
    base_service: baseService,
    account,
    status,
    key_count: configuredKeys.length,
    configured_keys: configuredKeys,
    missing_keys: missingKeys,
    updated_at: updatedAt,
  }
}

function buildProjectCredentialSummary(projectId: string): IntegrationSummaryRow[] {
  return listProjectCredentials(projectId)
    .map((serviceRow) => summarizeService(projectId, serviceRow.service, serviceRow.keys))
    .sort((a, b) => a.base_service.localeCompare(b.base_service) || (a.account || '').localeCompare(b.account || ''))
}

function buildAllProjectsCredentialSummary(): Array<{ project_id: string; integrations: IntegrationSummaryRow[] }> {
  const byProject = new Map<string, ReturnType<typeof listProjectCredentials>>()
  for (const row of listAllProjectCredentials()) {
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, [])
    byProject.get(row.project_id)!.push({
      service: row.service,
      keys: row.keys,
    })
  }
  return Array.from(byProject.entries())
    .map(([projectId, services]) => ({
      project_id: projectId,
      integrations: services
        .map((serviceRow) => summarizeService(projectId, serviceRow.service, serviceRow.keys))
        .sort((a, b) => a.base_service.localeCompare(b.base_service) || (a.account || '').localeCompare(b.account || '')),
    }))
    .sort((a, b) => a.project_id.localeCompare(b.project_id))
}

// --- Agents ---

router.get('/agents', (req: Request, res: Response) => {
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  res.json(getAllAgents(requestedProjectId ?? undefined, allowedProjectIds))
})

// NOTE: /agents/create MUST be registered before /agents/:id to avoid param capture
router.post('/agents/create', requireProjectRole('editor'), (req: Request, res: Response) => {
  const { id, name, emoji, role, mode, keywords, capabilities, systemPrompt } = req.body as {
    id: string; name: string; emoji: string; role: string; mode: string;
    keywords: string[]; capabilities: string[]; systemPrompt: string;
  }

  if (!id || !name || !emoji || !role || !mode || !systemPrompt) {
    res.status(400).json({ error: 'id, name, emoji, role, mode, and systemPrompt are required' })
    return
  }

  if (!/^[a-z0-9-]+$/.test(id)) {
    res.status(400).json({ error: 'id must be lowercase alphanumeric with dashes' })
    return
  }

  if (!['always-on', 'active', 'on-demand'].includes(mode)) {
    res.status(400).json({ error: 'mode must be always-on, active, or on-demand' })
    return
  }

  // Validate array fields
  if (keywords && (!Array.isArray(keywords) || keywords.some((k: unknown) => typeof k !== 'string'))) {
    res.status(400).json({ error: 'keywords must be an array of strings' })
    return
  }
  if (capabilities && (!Array.isArray(capabilities) || capabilities.some((c: unknown) => typeof c !== 'string'))) {
    res.status(400).json({ error: 'capabilities must be an array of strings' })
    return
  }

  // Sanitize string fields to prevent YAML frontmatter injection
  const sanitize = (s: string) => s.replace(/[\r\n]/g, ' ').trim()
  const safeName = sanitize(name)
  const safeRole = sanitize(role)
  const safeEmoji = sanitize(emoji)
  const safeKeywords = (keywords || []).map((k: string) => sanitize(k)).filter(Boolean)
  const safeCaps = (capabilities || []).map((c: string) => sanitize(c)).filter(Boolean)
  // Strip bare `---` lines to prevent YAML frontmatter injection
  const sanitizedSystemPrompt = (systemPrompt as string || '').replace(/^---$/gm, '').trim()

  if (!PROJECT_ROOT) return res.status(500).json({ error: 'PROJECT_ROOT not configured' })
  const agentsDir = join(PROJECT_ROOT, 'agents')

  // Ensure agents directory exists
  if (!existsSync(agentsDir)) {
    res.status(500).json({ error: 'agents/ directory does not exist on server' })
    return
  }

  const agentPath = join(agentsDir, `${id}.md`)

  if (existsSync(agentPath)) {
    res.status(409).json({ error: `Agent "${id}" already exists` })
    return
  }

  const keywordLines = safeKeywords.map((k: string) => `  - ${k}`).join('\n')
  const capLines = safeCaps.map((c: string) => `  - ${c}`).join('\n')

  const content = `---
id: ${id}
name: ${safeName}
emoji: ${safeEmoji}
role: ${safeRole}
mode: ${mode}
keywords:
${keywordLines || '  - ' + id}
capabilities:
${capLines || '  - web-search'}
---

# ${safeName} -- ${safeRole}

${sanitizedSystemPrompt}
`

  try {
    writeFileSync(agentPath, content, 'utf-8')

    upsertAgent({
      id,
      name: `${safeEmoji} ${safeName}`,
      status: 'idle',
      current_task: undefined,
    })

    logger.info({ agentId: id }, 'New agent created via dashboard')
    res.status(201).json({ ok: true, id, path: agentPath })
  } catch (err) {
    logger.error({ err, agentId: id }, 'Failed to create agent file')
    res.status(500).json({ error: 'Failed to write agent file' })
  }
})

router.get(
  '/agents/:id',
  requireProjectRoleForResource('viewer', (id) => getAgent(id)?.project_id ?? null),
  (req: Request, res: Response) => {
    const id = param(req, 'id')
    const agent = getAgent(id)
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' })
      return
    }
    res.json(agent)
  },
)

router.patch(
  '/agents/:id',
  requireProjectRoleForResource('editor', (id) => getAgent(id)?.project_id ?? null),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const agent = getAgent(id)
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' })
    return
  }
  const updates = req.body as Record<string, unknown>
  if ('project_id' in updates) {
    delete updates.project_id // prevent cross-project reassignment
  }
  if (updates.status && !['online', 'active', 'idle', 'sleeping', 'error'].includes(updates.status as string)) {
    res.status(400).json({ error: 'Invalid status value' })
    return
  }
  if (updates.status || updates.current_task !== undefined) {
    updateAgentStatus(
      id,
      (updates.status as string) ?? agent.status,
      updates.current_task as string | undefined
    )
  }
  // Allow updating other fields
  upsertAgent({ id, ...updates } as Parameters<typeof upsertAgent>[0])
  res.json(getAgent(id))
})

// Heartbeats are a bot-only callback; we must not let an authenticated member
// ping someone else's agent (which would (a) leak that agent's pending message
// count and (b) overwrite last_active). Admins are allowed for debugging; the
// bot user passes via requireBotOrAdmin. Regular members are rejected.
router.post('/agents/:id/heartbeat', requireBotOrAdmin, (req: Request, res: Response) => {
  const id = param(req, 'id')
  const agent = getAgent(id)
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' })
    return
  }
  updateAgentStatus(id, agent.status, agent.current_task)
  // Return any pending messages for this agent
  const pending = getMessagesForAgent(id, 'pending')
  res.json({ ok: true, pending_messages: pending.length, last_active: Date.now() })
})

// --- Agent Templates & Config ---

/** Parse YAML-ish frontmatter from markdown. Returns { frontmatter, body }. */
function parseAgentMarkdown(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }

  const fm: Record<string, unknown> = {}
  let currentKey = ''
  let arrayValues: string[] = []
  let inArray = false

  for (const line of match[1].split('\n')) {
    const arrayItem = line.match(/^\s+-\s+(.+)$/)
    if (arrayItem && inArray) {
      arrayValues.push(arrayItem[1])
      continue
    }
    // Flush previous array
    if (inArray) {
      fm[currentKey] = arrayValues
      inArray = false
      arrayValues = []
    }
    const kv = line.match(/^(\w[\w_-]*)\s*:\s*(.*)$/)
    if (kv) {
      currentKey = kv[1]
      const val = kv[2].trim()
      if (val === '' || val === '[]') {
        inArray = true
        arrayValues = []
      } else {
        // Strip quotes
        fm[currentKey] = val.replace(/^["']|["']$/g, '')
      }
    }
  }
  if (inArray) fm[currentKey] = arrayValues

  return { frontmatter: fm, body: match[2].trim() }
}

/** Build markdown from frontmatter + body */
function buildAgentMarkdown(fm: Record<string, unknown>, body: string): string {
  const lines: string[] = ['---']
  const arrayKeys = ['keywords', 'capabilities']
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) continue
    if (arrayKeys.includes(k) && Array.isArray(v)) {
      if (v.length === 0) continue
      lines.push(`${k}:`)
      for (const item of v) lines.push(`  - ${item}`)
    } else {
      // Quote emoji values that might have special chars
      const val = String(v)
      if (!val.trim()) continue
      if (k === 'emoji' && /[^\x20-\x7E]/.test(val)) {
        lines.push(`${k}: "${val}"`)
      } else {
        lines.push(`${k}: ${val}`)
      }
    }
  }
  lines.push('---', '', body, '')
  return lines.join('\n')
}

/**
 * Valid agent ID: lowercase alphanumerics, single hyphens, optional `--`
 * project separator. Anything else (slashes, dots, backslashes) is rejected
 * to prevent path traversal via route params.
 */
const AGENT_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/

function isValidAgentId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && AGENT_ID_RE.test(id)
}

/** Resolve the .md file path for an agent ID. Checks projects/, agents/, templates/. */
function resolveAgentFilePath(id: string): string | null {
  if (!isValidAgentId(id)) return null
  if (!PROJECT_ROOT) return null

  const rootResolved = pathResolve(PROJECT_ROOT)

  // Defense in depth: after joining, assert the resolved path stays under
  // projectRoot. join() normalizes but this catches any future regression.
  const safeExists = (candidate: string): string | null => {
    const resolved = pathResolve(candidate)
    if (!resolved.startsWith(rootResolved + '/') && resolved !== rootResolved) return null
    return existsSync(resolved) ? resolved : null
  }

  // Check if it's a project-scoped agent (project--template)
  const dashIdx = id.indexOf('--')
  if (dashIdx !== -1) {
    const projectId = id.substring(0, dashIdx)
    const templateId = id.substring(dashIdx + 2)
    const hit = safeExists(join(PROJECT_ROOT, 'projects', projectId, 'agents', `${templateId}.md`))
    if (hit) return hit
  }

  // Check agents/ (base agents)
  const agentPath = safeExists(join(PROJECT_ROOT, 'agents', `${id}.md`))
  if (agentPath) return agentPath

  // Check templates/
  const templatePath = safeExists(join(PROJECT_ROOT, 'templates', `${id}.md`))
  if (templatePath) return templatePath

  // Check all project dirs
  const projectsDir = join(PROJECT_ROOT, 'projects')
  if (existsSync(projectsDir)) {
    for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const hit = safeExists(join(projectsDir, dir.name, 'agents', `${id}.md`))
      if (hit) return hit
    }
  }

  return null
}

// List available templates (base agents + template agents)
router.get('/templates', (_req: Request, res: Response) => {
  if (!PROJECT_ROOT) return res.status(500).json({ error: 'PROJECT_ROOT not configured' })
  const results: Array<Record<string, unknown> & { source: string }> = []

  // Base agents
  const agentsDir = join(PROJECT_ROOT, 'agents')
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir).filter(f => f.endsWith('.md'))) {
      try {
        const content = readFileSync(join(agentsDir, file), 'utf-8')
        const { frontmatter, body } = parseAgentMarkdown(content)
        results.push({ ...frontmatter, source: 'base', body: body.split('\n').slice(0, 3).join('\n') })
      } catch { /* skip unreadable */ }
    }
  }

  // Templates
  const templatesDir = join(PROJECT_ROOT, 'templates')
  if (existsSync(templatesDir)) {
    for (const file of readdirSync(templatesDir).filter(f => f.endsWith('.md'))) {
      try {
        const content = readFileSync(join(templatesDir, file), 'utf-8')
        const { frontmatter, body } = parseAgentMarkdown(content)
        results.push({ ...frontmatter, source: 'template', body: body.split('\n').slice(0, 3).join('\n') })
      } catch { /* skip unreadable */ }
    }
  }

  res.json(results)
})

// Read agent config (parsed .md file)
// NOTE: Must be registered before /agents/:id to avoid param capture
router.get(
  '/agents/config/:id',
  requireProjectRoleForResource('viewer', (id) => getAgent(id)?.project_id ?? null),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const filePath = resolveAgentFilePath(id)

  if (!filePath) {
    // Agent exists in DB but has no .md file
    const dbAgent = getAgent(id)
    if (dbAgent) {
      res.json({ id, source: 'db-only', frontmatter: { id, name: dbAgent.name, role: dbAgent.role }, body: '' })
      return
    }
    res.status(404).json({ error: 'Agent config file not found' })
    return
  }

  try {
    const content = readFileSync(filePath, 'utf-8')
    const { frontmatter, body } = parseAgentMarkdown(content)
    // Determine source type from path
    let source = 'custom'
    if (filePath.includes('/agents/')) source = 'base'
    if (filePath.includes('/templates/')) source = 'template'
    if (filePath.includes('/projects/')) source = 'project'

    res.json({ id, source, frontmatter, body })
  } catch (err) {
    logger.error({ err, id }, 'Failed to read agent config')
    res.status(500).json({ error: 'Failed to read agent config file' })
  }
  },
)

// Update agent config (write back to .md file + update DB)
router.put(
  '/agents/config/:id',
  requireProjectRoleForResource('editor', (id) => {
    const agent = getAgent(id)
    if (agent?.project_id) return agent.project_id
    // For new agents being created via config PUT, fall back to query/body project_id
    return null
  }),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const { frontmatter, body } = req.body as { frontmatter: Record<string, unknown>; body: string }

  if (!frontmatter || body === undefined) {
    res.status(400).json({ error: 'frontmatter and body are required' })
    return
  }

  // Sanitize all string fields to prevent YAML frontmatter injection
  const sanitize = (s: string) => s.replace(/[\r\n]/g, ' ')
  for (const [k, v] of Object.entries(frontmatter)) {
    if (typeof v === 'string') {
      frontmatter[k] = sanitize(v)
    } else if (Array.isArray(v)) {
      frontmatter[k] = v.map((item: unknown) => typeof item === 'string' ? sanitize(item) : item)
    }
  }
  const sanitizedBody = String(body).replace(/\r/g, '').trim()

  const providerMode = frontmatter.provider_mode ? String(frontmatter.provider_mode) : 'inherit'
  if (!AGENT_PROVIDER_MODES.has(providerMode)) {
    res.status(400).json({ error: 'provider_mode must be inherit, claude_desktop, codex_local, anthropic_api, or openai_api' })
    return
  }

  const fallbackPolicy = normalizeFallbackPolicy(frontmatter.fallback_policy ? String(frontmatter.fallback_policy) : '')
  if (fallbackPolicy && !FALLBACK_POLICIES.has(fallbackPolicy)) {
    res.status(400).json({ error: 'fallback_policy must be disabled or enabled' })
    return
  }

  const modelTier = frontmatter.model_tier ? String(frontmatter.model_tier) : ''
  if (modelTier && !MODEL_TIERS.has(modelTier)) {
    res.status(400).json({ error: 'model_tier must be cheap, balanced, or premium' })
    return
  }

  const explicitProvider = providerMode !== 'inherit' ? providerMode : ''
  const configuredModel = frontmatter.model ? String(frontmatter.model).trim() : ''
  if (explicitProvider === 'claude_desktop' && configuredModel) {
    res.status(400).json({ error: 'model is not used for claude_desktop execution; leave it blank or choose another provider' })
    return
  }
  if (explicitProvider && configuredModel && !isModelCompatibleWithProvider(explicitProvider, configuredModel)) {
    res.status(400).json({ error: `model "${configuredModel}" is not compatible with ${explicitProvider}` })
    return
  }

  let filePath = resolveAgentFilePath(id)

  if (!filePath) {
    // Create new file in agents/ dir
    if (!PROJECT_ROOT) return res.status(500).json({ error: 'PROJECT_ROOT not configured' })

    // If project-scoped, put in projects/
    const dashIdx = id.indexOf('--')
    if (dashIdx !== -1) {
      const projectId = id.substring(0, dashIdx)
      const templateId = id.substring(dashIdx + 2)
      const dir = join(PROJECT_ROOT, 'projects', projectId, 'agents')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      filePath = join(dir, `${templateId}.md`)
    } else {
      filePath = join(PROJECT_ROOT, 'agents', `${id}.md`)
    }
  }

  try {
    const content = buildAgentMarkdown(frontmatter, sanitizedBody)
    writeFileSync(filePath, content, 'utf-8')

    // Sync key fields to DB
    const displayName = frontmatter.name ? `${frontmatter.emoji || ''} ${frontmatter.name}`.trim() : undefined
    const roleStr = frontmatter.role ? String(frontmatter.role) : undefined
    const modeStr = frontmatter.mode ? String(frontmatter.mode) : undefined
    const updates: Record<string, unknown> = { id }
    if (displayName) updates.name = displayName
    if (roleStr) updates.role = roleStr
    if (modeStr) updates.mode = modeStr
    upsertAgent(updates as Parameters<typeof upsertAgent>[0])

    logger.info({ agentId: id }, 'Agent config updated via dashboard')
    res.json({ ok: true, id, filePath })
  } catch (err) {
    logger.error({ err, agentId: id }, 'Failed to update agent config')
    res.status(500).json({ error: 'Failed to write agent config' })
  }
})

// --- Messages ---

router.post('/messages', requireProjectRole('editor'), (req: Request, res: Response) => {
  const { from, to, content, type } = req.body as {
    from: string; to: string; content: string; type?: string
  }
  if (!from || !to || !content) {
    res.status(400).json({ error: 'from, to, and content are required' })
    return
  }
  const message = sendMessage(from, to, content, type)
  notifyAgentMessage(to, message)
  addFeedItem(from, 'sent_message', `To ${to}: ${content.slice(0, 100)}`)
  logger.info({ from, to, type: message.type }, 'Message sent')
  res.status(201).json(message)
})

router.get('/messages', (req: Request, res: Response) => {
  const agentId = req.query.agent as string | undefined
  const status = req.query.status as string | undefined
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  if (agentId) {
    // Scope check: verify the agent belongs to a project the caller can access.
    const agentRecord = getAgent(agentId)
    if (!agentRecord) {
      res.status(404).json({ error: 'Agent not found' })
      return
    }
    const agentProjectId = agentRecord.project_id ?? null
    // Admin: allowedProjectIds === null -- always passes.
    // Member: must have agentProjectId in their allowed set.
    if (Array.isArray(allowedProjectIds) && (!agentProjectId || !allowedProjectIds.includes(agentProjectId))) {
      res.status(404).json({ error: 'Agent not found' })
      return
    }
    res.json(getMessagesForAgent(agentId, status))
  } else {
    res.json(getRecentMessages(50, requestedProjectId ?? undefined, allowedProjectIds))
  }
})

router.patch('/messages/:id', requireProjectRole('editor'), (req: Request, res: Response) => {
  const id = parseInt(param(req, 'id'), 10)
  if (isNaN(id)) {
    res.status(400).json({ error: 'id must be a number' })
    return
  }
  const { status } = req.body as { status: string }
  if (status === 'delivered') {
    markDelivered(id)
  } else if (status === 'completed') {
    markCompleted(id)
  } else {
    res.status(400).json({ error: 'status must be delivered or completed' })
    return
  }
  res.json({ ok: true })
})

// NOTE: /messages/recent MUST be registered before any /messages/:id route
// to prevent Express from matching 'recent' as a message ID.
router.get('/messages/recent', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string, 10) || 50
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  res.json(getRecentMessages(limit, requestedProjectId ?? undefined, allowedProjectIds))
})

// --- Feed ---

router.post('/feed', requireProjectRole('editor'), (req: Request, res: Response) => {
  const { agent_id, action, detail, project_id } = req.body as {
    agent_id: string; action: string; detail?: string; project_id?: string
  }
  if (!agent_id || !action) {
    res.status(400).json({ error: 'agent_id and action are required' })
    return
  }
  const item = addFeedItem(agent_id, action, detail, project_id || undefined)
  broadcastFeedUpdate(item)
  res.status(201).json(item)
})

router.get('/feed', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string, 10) || 50
  const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined
  const agentId = req.query.agent as string | undefined
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  res.json(getRecentFeed(limit, since, requestedProjectId ?? undefined, agentId, allowedProjectIds))
})

// --- Metrics ---

router.post('/metrics', requireProjectRole('editor'), (req: Request, res: Response) => {
  const { category, key, value, metadata } = req.body as {
    category: string; key: string; value: number; metadata?: string
  }
  if (!category || !key || value === undefined) {
    res.status(400).json({ error: 'category, key, and value are required' })
    return
  }
  const pid = req.body.project_id as string | undefined
  recordMetric(category, key, value, metadata, pid)
  res.status(201).json({ ok: true })
})

router.get('/metrics/:category', (req: Request, res: Response, next) => {
  // Skip the generic handler for categories with dedicated handlers below
  const cat = param(req, 'category')
  if (cat === 'youtube' || cat === 'collect') return next()
  const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  res.json(getMetrics(cat, since, requestedProjectId ?? undefined, allowedProjectIds))
})

router.post('/metrics/collect', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const { runMetricsCollection } = await import('./metrics-collector.js')
    const summary = await runMetricsCollection()
    res.json({ ok: true, summary })
  } catch (err) {
    logger.error({ err }, 'Metrics collection endpoint failed')
    res.status(500).json({ ok: false, error: 'Internal server error' })
  }
})

// --- Quota Awareness ---

router.get('/quota', (_req: Request, res: Response) => {
  try {
    res.json(getQuotaStatus())
  } catch (err) {
    logger.error({ err }, 'getQuotaStatus failed')
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/quota/:platform/clear', requireAdmin, (req: Request, res: Response) => {
  const platform = param(req, 'platform')
  clearCooldown(platform)
  res.json({ ok: true, platform })
})

// --- Dashboard ---

router.get('/dashboard', (req: Request, res: Response) => {
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  const pid = requestedProjectId ?? undefined
  const agents = getAllAgents(pid, allowedProjectIds)
  const recentFeed = getRecentFeed(20, undefined, pid, undefined, allowedProjectIds)
  const activeAgents = agents.filter(a => a.status === 'active' || a.status === 'online').length
  const db = getDb()

  let pendingMessages: { c: number }
  let totalMessages: { c: number }
  if (pid) {
    pendingMessages = db.prepare("SELECT COUNT(*) as c FROM messages WHERE status = 'pending' AND project_id = ?").get(pid) as { c: number }
    totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages WHERE project_id = ?').get(pid) as { c: number }
  } else if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) {
      pendingMessages = { c: 0 }
      totalMessages = { c: 0 }
    } else {
      const ph = allowedProjectIds.map(() => '?').join(', ')
      pendingMessages = db.prepare(`SELECT COUNT(*) as c FROM messages WHERE status = 'pending' AND project_id IN (${ph})`).get(...allowedProjectIds) as { c: number }
      totalMessages = db.prepare(`SELECT COUNT(*) as c FROM messages WHERE project_id IN (${ph})`).get(...allowedProjectIds) as { c: number }
    }
  } else {
    pendingMessages = db.prepare("SELECT COUNT(*) as c FROM messages WHERE status = 'pending'").get() as { c: number }
    totalMessages = db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }
  }

  res.json({
    agents,
    recentFeed,
    stats: {
      total_agents: agents.length,
      active_agents: activeAgents,
      pending_messages: pendingMessages.c,
      total_messages: totalMessages.c,
      connected_clients: getConnectedClients().length,
    },
  })
})

router.get('/dashboard/overview', (req: Request, res: Response) => {
  // Scope the overview: members should not see cross-project counts unless
  // they have access. Admins (allowedProjectIds === null) see everything.
  const { allowedProjectIds } = resolveProjectScope(req)
  res.json(getProjectOverview(allowedProjectIds))
})

router.get('/health', (_req: Request, res: Response) => {
  const dbSize = getDb().prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as { size: number }
  const mem = process.memoryUsage()

  const warnings: string[] = []
  if (!process.env.CREDENTIAL_ENCRYPTION_KEY) {
    warnings.push('CREDENTIAL_ENCRYPTION_KEY not set: credential decryption disabled, integrations will fail')
  }
  if (!process.env.WS_SECRET && process.env.NODE_ENV === 'production') {
    warnings.push('WS_SECRET not set in production: unauthenticated WebSocket connections possible')
  }
  if (!process.env.DASHBOARD_API_TOKEN) {
    warnings.push('DASHBOARD_API_TOKEN not set: API is unauthenticated')
  }

  res.json({
    status: warnings.length === 0 ? 'ok' : 'degraded',
    uptime: process.uptime(),
    db_size_bytes: dbSize.size,
    memory: {
      rss: mem.rss,
      heap_used: mem.heapUsed,
      heap_total: mem.heapTotal,
    },
    connected_clients: getConnectedClients(),
    warnings,
    timestamp: Date.now(),
  })
})

// --- Bot Health (from telemetry.db system_health table) ---

router.get('/health/bot', (_req: Request, res: Response) => {
  const snapshots = getBotHealthSnapshots()
  res.json({ snapshots, services: [] })
})

// --- Security ---

router.get('/security/findings', (req: Request, res: Response) => {
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  const filter: FindingsFilter = {
    severity: req.query.severity as string | undefined,
    scanner_id: req.query.scanner_id as string | undefined,
    status: req.query.status as string | undefined,
    project_id: requestedProjectId ?? (req.query.project_id as string | undefined),
    allowedProjectIds: requestedProjectId ? undefined : allowedProjectIds,
    limit: parseInt(req.query.limit as string, 10) || 50,
    offset: parseInt(req.query.offset as string, 10) || 0,
  }
  res.json(getSecurityFindings(filter))
})

router.post('/security/findings', requireProjectRole('editor'), (req: Request, res: Response) => {
  const findings = req.body.findings as Record<string, unknown>[]
  if (!Array.isArray(findings)) {
    res.status(400).json({ error: 'findings array is required' })
    return
  }
  // Cap the array size so a malformed or abusive payload can't block the event
  // loop for seconds with tens of thousands of upserts.
  if (findings.length > 1000) {
    res.status(400).json({ error: 'too many findings in one request (max 1000)' })
    return
  }
  // SECURITY: the caller has editor on `scope.requestedProjectId` (validated
  // by requireProjectRole + scopeProjects). Without this guard an attacker
  // could pass `?project_id=A` to pass the gate and then POST findings with
  // per-row `project_id: "B"`, planting false-positive criticals OR flipping
  // existing findings in any project (the upsert ON CONFLICT path updates).
  // Force every finding's project_id to match the gate value; admins can still
  // cross-post because they have access to every project.
  const { requestedProjectId } = resolveProjectScope(req)
  const gateProjectId = requestedProjectId ?? (req.query.project_id as string | undefined) ?? (req.body?.project_id as string | undefined)
  if (!req.user?.isAdmin && !gateProjectId) {
    res.status(400).json({ error: 'project_id required' })
    return
  }
  let count = 0
  for (const f of findings) {
    const rowProject = typeof f.project_id === 'string' ? f.project_id : undefined
    if (!req.user?.isAdmin) {
      // Force tenant to the gated project. Silently rewriting is better than
      // rejecting because old callers may not send project_id at all.
      f.project_id = gateProjectId
    } else if (rowProject && !rowProject.trim()) {
      f.project_id = gateProjectId
    }
    upsertSecurityFinding(f)
    count++
  }
  logger.info({ count, gateProjectId }, 'Bulk upserted security findings')
  res.status(201).json({ ok: true, upserted: count })
})

router.patch(
  '/security/findings/:id',
  requireProjectRoleForResource('editor', (id) => {
    const row = getDb().prepare('SELECT project_id FROM security_findings WHERE id = ?').get(id) as { project_id: string } | undefined
    return row?.project_id ?? null
  }),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const { status } = req.body as { status: string }
  if (!status || !['open', 'fixed', 'acknowledged', 'false-positive'].includes(status)) {
    res.status(400).json({ error: 'status must be one of: open, fixed, acknowledged, false-positive' })
    return
  }
  const updated = updateSecurityFindingStatus(id, status)
  if (!updated) {
    res.status(404).json({ error: 'Finding not found' })
    return
  }
  res.json({ ok: true, id, status })
  },
)

router.get('/security/scans', (req: Request, res: Response) => {
  const limit = req.query.limit ? (parseInt(req.query.limit as string, 10) || 50) : 50
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  res.json(getSecurityScans(limit, requestedProjectId ?? undefined, allowedProjectIds))
})

router.post('/security/scans', requireProjectRole('editor'), (req: Request, res: Response) => {
  const scan = req.body as Record<string, unknown>
  if (!scan.id || (!scan.scanner_id && !scan.scannerId)) {
    res.status(400).json({ error: 'id and scanner_id are required' })
    return
  }
  recordSecurityScan(scan)
  res.status(201).json({ ok: true })
})

router.get('/security/score', (req: Request, res: Response) => {
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  res.json(getSecurityScore(requestedProjectId ?? undefined, allowedProjectIds))
})

router.post('/security/score', requireProjectRole('editor'), (req: Request, res: Response) => {
  const { requestedProjectId } = resolveProjectScope(req)
  const pid = (req.body?.project_id as string | undefined) ?? requestedProjectId ?? undefined
  try {
    upsertSecurityScore(req.body, pid)
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: 'Invalid score payload' })
  }
})

router.post('/security/trigger', requireProjectRole('editor'), (req: Request, res: Response) => {
  const { scope, scannerId, project_id } = req.body as { scope?: string; scannerId?: string; project_id?: string }
  broadcastToMac({
    type: 'security-trigger',
    scope: scope ?? 'daily',
    scannerId,
    project_id,
  })
  logger.info({ scope, scannerId, project_id }, 'Security trigger sent to Mac')
  res.json({ ok: true, message: 'Trigger sent to Mac' })
})

router.get('/security/autofixes', (req: Request, res: Response) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  res.json(getSecurityAutoFixes(
    limit,
    requestedProjectId ?? (req.query.project_id as string | undefined),
    allowedProjectIds,
  ))
})

// --- Chat ---

router.get('/chat', (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string, 10) || 50
  const before = req.query.before ? parseInt(req.query.before as string, 10) : undefined
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  res.json(queryChatMessages({
    limit,
    before,
    projectId: requestedProjectId ?? undefined,
    allowedProjectIds,
  }))
})

router.post('/chat/send', requireProjectRole('viewer'), (req: Request, res: Response) => {
  const { text, project_id } = req.body as { text?: string; project_id?: string }
  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text is required' })
    return
  }
  // Relay to bot via WebSocket
  broadcastToMac({
    type: 'chat_message',
    text: text.trim(),
    chatId: project_id ? `dashboard:${project_id}` : 'dashboard:default',
    source: 'dashboard',
    project_id: project_id,
    timestamp: Date.now(),
  })
  res.status(202).json({ status: 'accepted', message: 'Sent to bot for processing' })
})

// POST /chat/response -- REST fallback for durable chat response delivery.
// Called by the Mac bot after a successful agent run in case the WS drops during a long run.
// Stores the response in telemetry DB and broadcasts to all dashboard clients.
router.post('/chat/response', requireBotOrAdmin, (req: Request, res: Response) => {
  const data = req.body as Record<string, unknown>
  if (!data.event_id || typeof data.event_id !== 'string') {
    res.status(400).json({ error: 'event_id required' })
    return
  }
  if (!data.result_text || typeof data.result_text !== 'string') {
    res.status(400).json({ error: 'result_text required' })
    return
  }
  insertChatEvent(data)
  broadcastChatResponse(data)
  res.status(201).json({ status: 'ok' })
})

// POST /chat/events -- sync a single agent_events row from Mac bot to server DB.
// Fire-and-forget from the bot; server stores it so GET /chat returns full history.
router.post('/chat/events', requireBotOrAdmin, (req: Request, res: Response) => {
  const row = req.body as Record<string, unknown>
  if (!row.event_id || typeof row.event_id !== 'string') {
    res.status(400).json({ error: 'event_id required' })
    return
  }
  insertChatEvent(row)
  res.status(201).json({ status: 'ok' })
})

// --- Scheduled Tasks ---

router.get('/tasks', (req: Request, res: Response) => {
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  const tasks = getAllScheduledTasks(requestedProjectId ?? undefined, allowedProjectIds)
  res.json(tasks)
})

router.get(
  '/tasks/:id',
  requireProjectRoleForResource('viewer', (id) => getScheduledTask(id)?.project_id ?? null),
  (req: Request, res: Response) => {
    const id = param(req, 'id')
    const task = getScheduledTask(id)
    if (!task) {
      res.status(404).json({ error: 'Task not found' })
      return
    }
    res.json(task)
  },
)

router.post(
  '/tasks/:id/run',
  requireProjectRoleForResource('editor', (id) => getScheduledTask(id)?.project_id ?? null),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const task = getScheduledTask(id)
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  broadcastToMac({ type: 'run-task', taskId: id })
  logger.info({ taskId: id }, 'Task run triggered via dashboard')
  res.json({ ok: true, message: 'Run triggered' })
})

router.patch(
  '/tasks/:id',
  requireProjectRoleForResource('editor', (id) => getScheduledTask(id)?.project_id ?? null),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const task = getScheduledTask(id)
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  const { status } = req.body as { status?: string }
  if (!status || !['active', 'paused'].includes(status)) {
    res.status(400).json({ error: 'status must be active or paused' })
    return
  }
  const updated = updateScheduledTaskStatus(id, status as 'active' | 'paused')
  if (!updated) {
    res.status(500).json({ error: 'Failed to update task' })
    return
  }
  // Tell the bot to update its local DB
  broadcastToMac({ type: 'task-status', taskId: id, status })
  res.json({ ok: true, id, status })
})

router.post('/tasks', requireProjectRole('editor'), (req: Request, res: Response) => {
  const { id, chat_id, prompt, schedule, project_id } = req.body as {
    id?: string; chat_id?: string; prompt?: string; schedule?: string; project_id?: string
  }
  if (!id || !chat_id || !prompt || !schedule) {
    res.status(400).json({ error: 'id, chat_id, prompt, and schedule are required' })
    return
  }
  if (getScheduledTask(id)) {
    res.status(409).json({ error: 'Task with this ID already exists' })
    return
  }
  if (project_id && !isValidProjectId(project_id)) {
    return res.status(400).json({ error: 'Invalid project_id' })
  }
  if (schedule) {
    try {
      CronExpressionParser.parse(schedule)
    } catch {
      return res.status(400).json({ error: 'Invalid cron expression' })
    }
  }
  const nextRun = (() => {
    try {
      // Simple next-minute-aligned estimate: round up to the next whole minute
      // The bot will recompute an exact next_run via computeNextRun() on task-created receipt.
      const now = Date.now()
      const msPerMin = 60_000
      return Math.ceil((now + 1) / msPerMin) * msPerMin
    } catch {
      return 0
    }
  })()
  try {
    createScheduledTask({ id, chat_id, prompt, schedule, next_run: nextRun, project_id })
    broadcastToMac({ type: 'task-created', taskId: id, data: { id, chat_id, prompt, schedule, project_id: project_id || 'default' } })
    res.json({ ok: true, id })
  } catch (err) {
    logger.error({ err }, 'POST /tasks failed')
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put(
  '/tasks/:id',
  requireProjectRoleForResource('editor', (id) => getScheduledTask(id)?.project_id ?? null),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const task = getScheduledTask(id)
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  const { prompt, schedule, chat_id } = req.body as { prompt?: string; schedule?: string; chat_id?: string }
  const updated = updateScheduledTask(id, { prompt, schedule, chat_id })
  if (!updated) {
    res.status(400).json({ error: 'No valid fields to update' })
    return
  }
  broadcastToMac({ type: 'task-updated', taskId: id, data: { prompt, schedule, chat_id } })
  res.json({ ok: true, id })
})

router.delete(
  '/tasks/:id',
  requireProjectRoleForResource('editor', (id) => getScheduledTask(id)?.project_id ?? null),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const deleted = deleteScheduledTask(id)
  if (!deleted) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  broadcastToMac({ type: 'task-deleted', taskId: id })
  res.json({ ok: true, id })
})

// --- Research ---

router.get('/research', (req: Request, res: Response) => {
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  const filter: ResearchFilter = {
    category: req.query.category as string | undefined,
    status: req.query.status as string | undefined,
    pipeline: req.query.pipeline as string | undefined,
    project_id: requestedProjectId ?? undefined,
    allowedProjectIds: requestedProjectId ? undefined : allowedProjectIds,
    limit: req.query.limit ? (parseInt(req.query.limit as string, 10) || undefined) : undefined,
    offset: req.query.offset ? (parseInt(req.query.offset as string, 10) || undefined) : undefined,
  }
  res.json(getResearchItems(filter))
})

router.get('/research/stats', (req: Request, res: Response) => {
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  res.json(getResearchStats(requestedProjectId ?? undefined, allowedProjectIds))
})

router.get(
  '/research/:id',
  requireProjectRoleForResource('viewer', (id) => getResearchItem(id)?.project_id ?? null),
  (req: Request, res: Response) => {
    const id = param(req, 'id')
    const item = getResearchItem(id)
    if (!item) {
      res.status(404).json({ error: 'Research item not found' })
      return
    }
    res.json(item)
  },
)

router.post('/research', requireProjectRole('editor'), (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>
  if (!body.id || !body.topic) {
    res.status(400).json({ error: 'id and topic are required' })
    return
  }
  upsertResearchItem(body)
  addFeedItem(body.found_by as string ?? 'scout', 'research_added', `New research: ${(body.topic as string).slice(0, 80)}`)
  res.status(201).json(getResearchItem(body.id as string))
})

router.patch(
  '/research/:id',
  requireProjectRoleForResource('editor', (id) => getResearchItem(id)?.project_id ?? null),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const existing = getResearchItem(id)
  if (!existing) {
    res.status(404).json({ error: 'Research item not found' })
    return
  }
  const updates = req.body as Record<string, unknown>
  upsertResearchItem({ ...existing, ...updates, id, updated_at: Date.now() })
  res.json(getResearchItem(id))
})

router.delete(
  '/research/:id',
  requireProjectRoleForResource('editor', (id) => getResearchItem(id)?.project_id ?? null),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const existing = getResearchItem(id)
  const deleted = deleteResearchItem(id)
  if (!deleted) {
    res.status(404).json({ error: 'Research item not found' })
    return
  }
  broadcastToMac({ type: 'research_deleted', item_id: id, project_id: existing?.project_id })
  res.json({ ok: true })
})

router.get(
  '/research/:id/chat',
  requireProjectRoleForResource('viewer', (id) => getResearchItem(id)?.project_id ?? null),
  (req: Request, res: Response) => {
    const id = param(req, 'id')
    const messages = getResearchChatHistory(getDb(), id)
    res.json({ messages })
  },
)

router.post(
  '/research/:id/chat',
  requireProjectRoleForResource('editor', (id) => getResearchItem(id)?.project_id ?? null),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const item = getResearchItem(id)
  if (!item) {
    res.status(404).json({ error: 'Research item not found' })
    return
  }

  const userMessage: string = typeof req.body?.message === 'string' ? req.body.message : ''
  const init: boolean = req.body?.init === true

  if (!init && !userMessage.trim()) {
    res.status(400).json({ error: 'message is required' })
    return
  }

  const context: ResearchItemContext = {
    id: item.id,
    topic: item.topic,
    source: item.source,
    source_url: item.source_url,
    category: item.category,
    score: item.score,
    status: item.status,
    pipeline: item.pipeline || null,
    notes: item.notes,
    competitor: item.competitor,
    created_at: item.created_at,
  }

  const history = getResearchChatHistory(getDb(), id)

  if (!init && userMessage) {
    const userMsg = makeResearchChatMessage(id, 'user', userMessage)
    saveResearchChatMessage(getDb(), userMsg)

    if (MEMORY_V2_ENABLED) {
      saveV2ChatMessage({
        chatId: `research:${id}`,
        projectId: item.project_id,
        userId: req.user?.id != null ? String(req.user.id) : null,
        role: 'user',
        content: userMessage,
      })
    }
  }

  res.json({ status: 'dispatched' })

  const agentJobId = randomUUID()
  const agentPrompt = buildScoutContext(context, history, userMessage, init)

  broadcastToMac({
    type: 'run_research_chat',
    item_id: id,
    project_id: item.project_id,
    prompt: agentPrompt,
    agent_job_id: agentJobId,
  })
})

router.post('/research/:id/chat/result', requireBotOrAdmin, (req: Request, res: Response) => {
  const itemId = param(req, 'id')
  const { agent_text, agent_job_id, project_id } = req.body as {
    agent_text?: string
    agent_job_id?: string
    project_id?: string
  }
  const text = agent_text ?? 'Scout completed with no output.'

  const db = getDb()
  const existing = agent_job_id
    ? db.prepare('SELECT id FROM research_chat_messages WHERE agent_job = ?').get(agent_job_id)
    : null
  if (existing) {
    res.status(200).json({ status: 'already_saved' })
    return
  }

  const agentMsg = makeResearchChatMessage(itemId, 'agent', text, agent_job_id)
  try {
    saveResearchChatMessage(db, agentMsg)
  } catch (err) {
    logger.error({ err, itemId }, 'Failed to save research chat result')
  }

  if (MEMORY_V2_ENABLED) {
    saveV2ChatMessage({
      chatId: `research:${itemId}`,
      projectId: project_id ?? 'default',
      userId: null,
      role: 'assistant',
      content: text,
    })
  }

  broadcastResearchChatResult({ item_id: itemId, project_id, message: agentMsg })
  res.status(201).json({ status: 'ok' })
})

const VALID_DRAFT_FORMATS = ['blog', 'youtube', 'linkedin', 'tweet', 'newsletter'] as const
type DraftFormat = typeof VALID_DRAFT_FORMATS[number]

const DRAFT_TITLE_TEMPLATES: Record<DraftFormat, string> = {
  blog: 'Blog draft: {topic}',
  youtube: 'YouTube script: {topic}',
  linkedin: 'LinkedIn post: {topic}',
  tweet: 'Tweet thread: {topic}',
  newsletter: 'Newsletter section: {topic}',
}

router.post(
  '/research/:id/draft',
  requireProjectRoleForResource('editor', (id) => getResearchItem(id)?.project_id ?? null),
  (req: Request, res: Response) => {
  const bdb = getBotDbWrite()
  if (!bdb) {
    res.status(503).json({ error: 'bot db unavailable' })
    return
  }

  const id = param(req, 'id')
  const format = req.body?.format as DraftFormat | undefined

  if (!format || !VALID_DRAFT_FORMATS.includes(format)) {
    res.status(400).json({ error: `format must be one of: ${VALID_DRAFT_FORMATS.join(', ')}` })
    return
  }

  const item = getResearchItem(id)
  if (!item) {
    res.status(404).json({ error: 'Research item not found' })
    return
  }

  const actionItemId = randomUUID()
  const title = DRAFT_TITLE_TEMPLATES[format].replace('{topic}', item.topic)
  const now = Date.now()
  const projectId = item.project_id ?? 'default'

  bdb.prepare(`
    INSERT INTO action_items (id, project_id, title, description, priority, status, source, proposed_by, research_item_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'medium', 'todo', 'research', 'scout', ?, ?, ?)
  `).run(
    actionItemId,
    projectId,
    title,
    `Draft content from research item "${item.topic}". Format: ${format}.`,
    id,
    now,
    now,
  )

  res.status(201).json({ action_item_id: actionItemId, title, format })

  const producerPrompt =
    `You are Producer. Draft content from this research item.\n\n` +
    `Format: ${format}\n` +
    `Topic: ${item.topic}\n` +
    `Source: ${item.source} (${item.source_url})\n` +
    `Category: ${item.category}\n` +
    `Score: ${item.score}/100\n` +
    `Notes: ${item.notes || 'none'}\n` +
    `Competitor: ${item.competitor || 'none'}\n\n` +
    `Write a draft appropriate for the format. No em dashes. No AI cliches. Be direct.`

  broadcastToMac({
    type: 'run_research_draft',
    action_item_id: actionItemId,
    research_item_id: id,
    project_id: projectId,
    format,
    prompt: producerPrompt,
  })
})

router.get(
  '/research/:id/drafts',
  requireProjectRoleForResource('viewer', (id) => getResearchItem(id)?.project_id ?? null),
  (req: Request, res: Response) => {
    const bdb = getBotDbWrite()
    if (!bdb) {
      res.status(503).json({ error: 'bot db unavailable' })
      return
    }
    const id = param(req, 'id')
    const drafts = bdb.prepare(`
      SELECT id, title, status, created_at, updated_at
      FROM action_items
      WHERE research_item_id = ?
      ORDER BY created_at DESC
    `).all(id)
    res.json({ drafts })
  },
)

const INVESTIGATE_COOLDOWN_MS = 60 * 60 * 1000

router.post(
  '/research/:id/investigate',
  requireProjectRoleForResource('editor', (id) => getResearchItem(id)?.project_id ?? null),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const item = getResearchItem(id)
  if (!item) {
    res.status(404).json({ error: 'Research item not found' })
    return
  }

  const now = Date.now()
  const last = item.last_investigated_at ?? 0
  if (last && now - last < INVESTIGATE_COOLDOWN_MS) {
    const remainingMs = INVESTIGATE_COOLDOWN_MS - (now - last)
    res.status(429).json({
      error: 'cooldown',
      remaining_ms: remainingMs,
      message: `Last investigated ${Math.floor((now - last) / 60000)}m ago. Try again in ${Math.ceil(remainingMs / 60000)}m.`,
    })
    return
  }

  updateResearchInvestigatedAt(id, now)

  res.status(202).json({ status: 'dispatched' })

  const projectId = item.project_id ?? 'default'
  const prompt =
    `You are Scout. Do a second pass on this research item. ` +
    `Return: recent developments (past 30 days), competitor coverage, and 2-3 angles worth pursuing for the project's audience.\n\n` +
    `Topic: ${item.topic}\n` +
    `Source: ${item.source} (${item.source_url})\n` +
    `Category: ${item.category}\n` +
    `Current notes: ${item.notes || 'none'}\n\n` +
    `Return plain text. No em dashes. No AI cliches.`

  broadcastToMac({
    type: 'run_research_investigate',
    research_item_id: id,
    project_id: projectId,
    prompt,
  })
})

router.post('/research/:id/investigate/result', requireBotOrAdmin, (req: Request, res: Response) => {
  const id = param(req, 'id')
  const { agent_text, project_id } = req.body as { agent_text?: string; project_id?: string }
  const text = agent_text ?? ''

  const item = getResearchItem(id)
  if (!item) {
    res.status(404).json({ error: 'Research item not found' })
    return
  }

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const section = `\n\n### Investigation ${stamp}\n${text}`
  const newNotes = (item.notes || '') + section

  upsertResearchItem({ ...item, notes: newNotes, updated_at: Date.now() })

  const echoMsg = makeResearchChatMessage(
    id,
    'agent',
    `Investigation complete. Updated notes. Want to explore any of these angles?\n\n${text}`,
  )
  saveResearchChatMessage(getDb(), echoMsg)

  broadcastResearchInvestigationComplete({ item_id: id, project_id, notes: newNotes })
  broadcastResearchChatResult({ item_id: id, project_id, message: echoMsg })

  res.status(201).json({ status: 'ok' })
})

// --- Briefing ---

router.get('/briefing', (req: Request, res: Response) => {
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  const pid = requestedProjectId ?? undefined
  const db = getDb()

  // Pull up to 5 recent tasks with results
  let tasks: Array<{ id: string; last_result: string | null; last_run: number | null }>
  if (pid) {
    tasks = db.prepare(
      'SELECT id, last_result, last_run FROM scheduled_tasks WHERE project_id = ? AND last_run IS NOT NULL ORDER BY last_run DESC LIMIT 5'
    ).all(pid) as typeof tasks
  } else if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) {
      tasks = []
    } else {
      const ph = allowedProjectIds.map(() => '?').join(', ')
      tasks = db.prepare(
        `SELECT id, last_result, last_run FROM scheduled_tasks WHERE project_id IN (${ph}) AND last_run IS NOT NULL ORDER BY last_run DESC LIMIT 5`
      ).all(...allowedProjectIds) as typeof tasks
    }
  } else {
    tasks = db.prepare(
      'SELECT id, last_result, last_run FROM scheduled_tasks WHERE last_run IS NOT NULL ORDER BY last_run DESC LIMIT 5'
    ).all() as typeof tasks
  }

  const SKIP = /^(Agent returned no text|No response|Task (started|completed|failed|cancelled)|Interrupted|process restarted|SCHEDULED TASK)/i

  let summary: string | null = null
  let updatedAt: number | null = null
  const sources: string[] = []

  // Priority 1: board meeting agent_highlights (curated, project-level summary)
  const meeting = getLatestBoardMeeting(pid, allowedProjectIds)
  if (meeting) {
    if (meeting.agent_highlights) {
      try {
        const highlights: string[] = JSON.parse(meeting.agent_highlights as unknown as string)
        if (Array.isArray(highlights) && highlights.length > 0) {
          summary = highlights.map(h => `- ${h}`).join('\n')
          updatedAt = meeting.created_at ?? null
          sources.push('board-highlights')
        }
      } catch {
        // fall through
      }
    }
    if (!summary && meeting.briefing) {
      const firstPara =
        meeting.briefing
          .replace(/^#+\s.*\n?/gm, '')
          .split('\n')
          .find((l: string) => l.trim().length > 40) || meeting.briefing
      summary = firstPara.trim().slice(0, 400)
      updatedAt = meeting.created_at ?? null
      sources.push('board')
    }
  }

  // Priority 2: most recent meaningful task result
  if (!summary) {
    for (const t of tasks) {
      const text = (t.last_result || '').trim()
      if (text && !SKIP.test(text)) {
        summary = text.slice(0, 400)
        updatedAt = t.last_run
        sources.push(t.id)
        break
      }
    }
  }

  // Last resort: any task result even if noisy
  if (!summary) {
    const anyResult = tasks.find(t => (t.last_result || '').trim().length > 20)
    if (anyResult) {
      summary = (anyResult.last_result || '').trim().slice(0, 400)
      updatedAt = anyResult.last_run
      sources.push(anyResult.id)
    }
  }

  res.json({ summary, updated_at: updatedAt, sources })
})

// --- Board ---

router.get('/board', (req: Request, res: Response) => {
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  const pid = requestedProjectId ?? undefined
  const latest = getLatestBoardMeeting(pid, allowedProjectIds)
  const history = getBoardMeetingHistory(10, pid, allowedProjectIds)
  const openDecisions = getBoardDecisions('open', pid, allowedProjectIds)
  const resolvedDecisions = getBoardDecisions('resolved', pid, allowedProjectIds).slice(0, 10)
  const stats = getBoardStats(pid, allowedProjectIds)

  const tasks = getAllScheduledTasks(pid, allowedProjectIds)
  const boardTask = tasks.find(t => t.prompt.toLowerCase().includes('board meeting') || t.id.includes('board'))
  const nextMeeting = boardTask ? boardTask.next_run : null

  res.json({
    latest,
    decisions: { open: openDecisions, resolved: resolvedDecisions },
    history,
    stats: { ...stats, next_meeting: nextMeeting },
  })
})

router.post('/board/meetings', requireProjectRole('editor'), (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>
  if (!body.id || !body.date || !body.briefing) {
    res.status(400).json({ error: 'id, date, and briefing are required' })
    return
  }
  const pid = (body.project_id as string) ?? 'default'
  if (!isValidProjectId(pid)) {
    res.status(400).json({ error: `Invalid project_id: ${pid}` })
    return
  }
  createBoardMeeting({
    id: body.id as string,
    date: body.date as string,
    briefing: body.briefing as string,
    metrics_snapshot: typeof body.metrics_snapshot === 'string' ? body.metrics_snapshot : JSON.stringify(body.metrics_snapshot ?? {}),
    agent_highlights: typeof body.agent_highlights === 'string' ? body.agent_highlights : JSON.stringify(body.agent_highlights ?? []),
    status: (body.status as string) ?? 'draft',
    project_id: pid,
  })

  // Create decisions if provided
  const decisions = body.decisions as Array<{ id: string; description: string }> | undefined
  if (Array.isArray(decisions)) {
    for (const d of decisions) {
      if (d.id && d.description) {
        createBoardDecision({ id: d.id, meeting_id: body.id as string, description: d.description, project_id: pid })
      }
    }
  }

  res.status(201).json(getBoardMeeting(body.id as string))
})

router.patch(
  '/board/decisions/:id',
  requireProjectRoleForResource('editor', (id) => {
    const row = getDb().prepare('SELECT project_id FROM board_decisions WHERE id = ?').get(id) as { project_id: string } | undefined
    return row?.project_id ?? null
  }),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const { status } = req.body as { status?: string }
  if (!status || !['open', 'resolved', 'deferred', 'cancelled'].includes(status)) {
    res.status(400).json({ error: 'status must be one of: open, resolved, deferred, cancelled' })
    return
  }
  const updated = updateBoardDecisionStatus(id, status)
  if (!updated) {
    res.status(404).json({ error: 'Decision not found' })
    return
  }
  res.json({ ok: true, id, status })
})

// --- Costs ---

router.get('/costs', requireAdmin, (req: Request, res: Response) => {
  const range = (req.query.range as string) || '30d'
  if (!['7d', '30d', '90d', 'ytd'].includes(range)) {
    res.status(400).json({ error: 'range must be 7d, 30d, 90d, or ytd' })
    return
  }
  try {
    const { requestedProjectId } = resolveProjectScope(req)
    res.json(getCostSummary(range, requestedProjectId ?? undefined))
  } catch (err) {
    logger.error({ err }, 'Failed to get cost summary')
    res.status(503).json({ error: 'Telemetry database not available' })
  }
})

router.get('/costs/line-items', requireAdmin, (_req: Request, res: Response) => {
  res.json(getLineItems())
})

router.post('/costs/line-items', requireAdmin, (req: Request, res: Response) => {
  const { id, label, amount_usd, period } = req.body as {
    id: string; label: string; amount_usd: number; period: string
  }
  if (!id || !label || amount_usd === undefined || !period) {
    res.status(400).json({ error: 'id, label, amount_usd, and period are required' })
    return
  }
  if (!['monthly', 'yearly', 'one-time'].includes(period)) {
    res.status(400).json({ error: 'period must be monthly, yearly, or one-time' })
    return
  }
  upsertLineItem({ id, label, amount_usd, period })
  res.status(201).json({ ok: true })
})

router.patch('/costs/line-items/:id', requireAdmin, (req: Request, res: Response) => {
  const id = param(req, 'id')
  const updates = req.body as { amount_usd?: number; active?: number; label?: string }
  const updated = updateLineItem(id, updates)
  if (!updated) {
    res.status(404).json({ error: 'Line item not found or no changes' })
    return
  }
  res.json({ ok: true })
})

router.delete('/costs/line-items/:id', requireAdmin, (req: Request, res: Response) => {
  const id = param(req, 'id')
  const deleted = deleteLineItem(id)
  if (!deleted) {
    res.status(404).json({ error: 'Line item not found' })
    return
  }
  res.json({ ok: true })
})

// --- Comms ---

function parseSinceToMs(since: string | undefined): number | undefined {
  if (!since) return undefined
  const now = Date.now()
  const map: Record<string, number> = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  }
  const ms = map[since]
  return ms ? now - ms : undefined
}

router.get('/comms', (req: Request, res: Response) => {
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  const filter: CommsFilter = {
    agent: req.query.agent as string | undefined,
    type: req.query.type as string | undefined,
    sinceMs: parseSinceToMs(req.query.since as string | undefined),
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
    project_id: requestedProjectId ?? undefined,
    allowedProjectIds: requestedProjectId ? undefined : allowedProjectIds,
  }
  res.json(getCommsLog(filter))
})

router.get('/comms/connections', (req: Request, res: Response) => {
  const since = (req.query.since as string) || '1h'
  const sinceMs = parseSinceToMs(since)
  if (!sinceMs) {
    res.status(400).json({ error: 'Invalid since value. Use 1h, 24h, 7d, or 30d' })
    return
  }
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  res.json(getActiveConnections(sinceMs, requestedProjectId ?? undefined, allowedProjectIds))
})

// --- Logging ---

router.get('/logging', requireAdmin, (req: Request, res: Response) => {
  const { requestedProjectId } = resolveProjectScope(req)
  const filter = {
    project_id: requestedProjectId ?? undefined,
    channel: req.query.channel as string | undefined,
    bot_name: req.query.bot_name as string | undefined,
    direction: req.query.direction as string | undefined,
    search: req.query.search as string | undefined,
    sinceMs: parseSinceToMs(req.query.since as string | undefined),
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 50,
    offset: req.query.offset ? parseInt(req.query.offset as string, 10) : 0,
  }
  res.json(getChannelLog(filter))
})

// --- Themes ---

router.get('/themes', (_req: Request, res: Response) => {
  try {
    const themesDir = join(__dirname, '..', 'themes')
    if (!existsSync(themesDir)) {
      res.json([])
      return
    }
    const files = readdirSync(themesDir).filter(f => f.endsWith('.json'))
    const themes = files.map(f => {
      const raw = readFileSync(join(themesDir, f), 'utf-8')
      return JSON.parse(raw)
    })
    res.json(themes)
  } catch (err: any) {
    logger.error({ err }, 'GET /themes failed')
    res.status(500).json({ error: 'Failed to load theme' })
  }
})

router.get('/themes/:id', (req: Request, res: Response) => {
  try {
    const id = param(req, 'id').replace(/[^a-z0-9_-]/gi, '')
    const themeFile = join(__dirname, '..', 'themes', `${id}.json`)
    if (!existsSync(themeFile)) {
      res.status(404).json({ error: 'Theme not found' })
      return
    }
    const raw = readFileSync(themeFile, 'utf-8')
    res.json(JSON.parse(raw))
  } catch (err: any) {
    logger.error({ err }, 'GET /themes/:id failed')
    res.status(500).json({ error: 'Failed to load theme' })
  }
})

// --- Projects ---

router.get('/projects', (req: Request, res: Response) => {
  const { allowedProjectIds } = resolveProjectScope(req)
  const all = getAllProjectsWithSettings()
  // Admin bypass: allowedProjectIds === null -- return everything.
  // Member: filter to only projects they belong to.
  if (Array.isArray(allowedProjectIds)) {
    const allowed = new Set(allowedProjectIds)
    res.json(all.filter(p => allowed.has(p.id)))
    return
  }
  res.json(all)
})

router.get('/projects/:id', requireProjectRead('id'), (req: Request, res: Response) => {
  const id = param(req, 'id')
  const project = getProjectById(id)
  if (!project) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  const settings = getProjectSettingsById(id)
  res.json({ ...project, settings })
})

router.post('/projects', requireAdmin, (req: Request, res: Response) => {
  const { id, name, slug, display_name, icon, status, auto_archive_days } = req.body as {
    id: string; name: string; slug: string; display_name: string; icon?: string
    status?: 'active' | 'paused' | 'archived'
    auto_archive_days?: number | null
  }
  if (!id || !name || !slug || !display_name) {
    res.status(400).json({ error: 'Missing required fields: id, name, slug, display_name' })
    return
  }
  if (status && !['active', 'paused', 'archived'].includes(status)) {
    res.status(400).json({ error: 'status must be active, paused, or archived' })
    return
  }
  if (auto_archive_days !== undefined && auto_archive_days !== null && (!Number.isInteger(auto_archive_days) || auto_archive_days < 1 || auto_archive_days > 3650)) {
    res.status(400).json({ error: 'auto_archive_days must be an integer between 1 and 3650' })
    return
  }
  try {
    createProjectInDb({ id, name, slug, display_name, icon, status, auto_archive_days })
    // Auto-seed the default agent roster for the new project
    seedProjectAgents(id)
    res.status(201).json(getProjectById(id))
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(err).includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Project already exists' })
    }
    logger.error({ err }, 'POST /projects error')
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/projects/:id', requireProjectRole('editor'), (req: Request, res: Response) => {
  const id = param(req, 'id')
  const updates = req.body as Record<string, unknown>
  if (updates.status && !['active', 'paused', 'archived'].includes(updates.status as string)) {
    res.status(400).json({ error: 'status must be active, paused, or archived' })
    return
  }
  if (
    updates.auto_archive_days !== undefined &&
    updates.auto_archive_days !== null &&
    (!Number.isInteger(updates.auto_archive_days) || Number(updates.auto_archive_days) < 1 || Number(updates.auto_archive_days) > 3650)
  ) {
    res.status(400).json({ error: 'auto_archive_days must be an integer between 1 and 3650' })
    return
  }
  const existing = getProjectById(id)
  if (!existing) return res.status(404).json({ error: 'Project not found' })
  try {
    updateProjectInDb(id, updates)
    res.json(getProjectById(id))
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/projects/:id', requireAdmin, (req: Request, res: Response) => {
  const id = param(req, 'id')
  const existing = getProjectById(id)
  if (!existing) return res.status(404).json({ error: 'Project not found' })
  const deleted = deleteProjectFromDb(id)
  if (!deleted) {
    res.status(400).json({ error: 'Cannot delete default project' })
    return
  }
  res.json({ deleted: true })
})

router.get('/projects/:id/settings', requireProjectRead('id'), (req: Request, res: Response) => {
  const id = param(req, 'id')
  const settings = getProjectSettingsById(id)
  res.json(settings ?? {})
})

router.put('/projects/:id/settings', requireProjectRole('editor'), (req: Request, res: Response) => {
  const id = param(req, 'id')
  try {
    const body = req.body as Record<string, unknown>
    const execution_provider = body.execution_provider ? String(body.execution_provider) : undefined
    const execution_provider_secondary = body.execution_provider_secondary ? String(body.execution_provider_secondary) : undefined
    const execution_provider_fallback = body.execution_provider_fallback ? String(body.execution_provider_fallback) : undefined
    const execution_model = body.execution_model ? String(body.execution_model).trim() : undefined
    const execution_model_primary = body.execution_model_primary != null ? String(body.execution_model_primary).trim() : undefined
    const execution_model_secondary = body.execution_model_secondary != null ? String(body.execution_model_secondary).trim() : undefined
    const execution_model_fallback = body.execution_model_fallback != null ? String(body.execution_model_fallback).trim() : undefined
    const fallback_policy = normalizeFallbackPolicy(body.fallback_policy ? String(body.fallback_policy) : undefined)
    const model_tier = body.model_tier ? String(body.model_tier) : undefined

    const effectivePrimaryModel = execution_model_primary !== undefined ? execution_model_primary : execution_model
    const stages = [
      { label: 'primary', provider: execution_provider, model: effectivePrimaryModel },
      { label: 'secondary', provider: execution_provider_secondary, model: execution_model_secondary },
      { label: 'fallback', provider: execution_provider_fallback, model: execution_model_fallback },
    ]

    const validProviderList = Array.from(EXECUTION_PROVIDERS).join(', ')
    if (execution_provider && !EXECUTION_PROVIDERS.has(execution_provider)) {
      res.status(400).json({ error: `execution_provider must be one of: ${validProviderList}` })
      return
    }
    if (execution_provider_secondary && !EXECUTION_PROVIDERS.has(execution_provider_secondary)) {
      res.status(400).json({ error: `execution_provider_secondary must be one of: ${validProviderList}` })
      return
    }
    if (execution_provider_fallback && !EXECUTION_PROVIDERS.has(execution_provider_fallback)) {
      res.status(400).json({ error: `execution_provider_fallback must be one of: ${validProviderList}` })
      return
    }
    if (fallback_policy && !FALLBACK_POLICIES.has(fallback_policy)) {
      res.status(400).json({ error: 'fallback_policy must be disabled or enabled' })
      return
    }
    if (model_tier && !MODEL_TIERS.has(model_tier)) {
      res.status(400).json({ error: 'model_tier must be cheap, balanced, or premium' })
      return
    }
    for (const stage of stages) {
      if (stage.model && !stage.provider) {
        res.status(400).json({ error: `${stage.label} model requires a ${stage.label} provider` })
        return
      }
      if (stage.provider === 'claude_desktop' && stage.model) {
        res.status(400).json({ error: `${stage.label} model is not used for claude_desktop; leave it blank or choose another provider` })
        return
      }
      if (stage.provider && stage.model && !isModelCompatibleWithProvider(stage.provider as any, stage.model)) {
        res.status(400).json({ error: `${stage.label} model "${stage.model}" is not compatible with ${stage.provider}` })
        return
      }
    }

    const theme_id = body.theme_id != null ? String(body.theme_id) : undefined
    const primary_color = body.primary_color != null ? String(body.primary_color) : undefined
    const accent_color = body.accent_color != null ? String(body.accent_color) : undefined
    const sidebar_color = body.sidebar_color != null ? String(body.sidebar_color) : undefined
    const logo_path = body.logo_path != null ? String(body.logo_path) : undefined
    upsertProjectSettingsInDb({
      project_id: id,
      theme_id,
      primary_color,
      accent_color,
      sidebar_color,
      logo_path,
      execution_provider,
      execution_provider_secondary,
      execution_provider_fallback,
      execution_model: effectivePrimaryModel,
      execution_model_primary: execution_model_primary ?? effectivePrimaryModel,
      execution_model_secondary,
      execution_model_fallback,
      fallback_policy,
      model_tier,
    })
    broadcastToMac({
      type: 'project_settings_sync',
      project_id: id,
      settings: {
        theme_id: body.theme_id ?? null,
        primary_color: body.primary_color ?? null,
        accent_color: body.accent_color ?? null,
        sidebar_color: body.sidebar_color ?? null,
        logo_path: body.logo_path ?? null,
        execution_provider: execution_provider ?? null,
        execution_provider_secondary: execution_provider_secondary ?? null,
        execution_provider_fallback: execution_provider_fallback ?? null,
        execution_model: effectivePrimaryModel ?? null,
        execution_model_primary: execution_model_primary ?? effectivePrimaryModel ?? null,
        execution_model_secondary: execution_model_secondary ?? null,
        execution_model_fallback: execution_model_fallback ?? null,
        fallback_policy: fallback_policy ?? null,
        model_tier: model_tier ?? null,
      },
    })
    res.json(getProjectSettingsById(id))
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

// --- Project Agent Seeding ---

router.post('/projects/:id/seed-agents', requireProjectRole('editor'), (req: Request, res: Response) => {
  const id = param(req, 'id')
  try {
    const agents = seedProjectAgents(id)
    res.json(agents)
  } catch (err: any) {
    res.status(400).json({ error: err.message })
  }
})

router.delete(
  '/agents/:id',
  requireProjectRoleForResource('editor', (id) => getAgent(id)?.project_id ?? null),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const deleted = deleteAgent(id)
  if (!deleted) {
    res.status(403).json({ error: 'Cannot delete default project agents or agent not found' })
    return
  }

  // Also remove .md file if it exists
  const filePath = resolveAgentFilePath(id)
  if (filePath) {
    try { unlinkSync(filePath) } catch { /* file already gone, fine */ }
  }

  logger.info({ agentId: id }, 'Agent deleted via dashboard')
  res.json({ deleted: true })
})

// --- YouTube Proxy ---

function decryptCred(value: Buffer, iv: Buffer, tag: Buffer): string | null {
  const keyHex = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!keyHex || keyHex.length !== 64) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(value), decipher.final()]).toString('utf8')
    return plain.length > 0 ? plain : null
  } catch {
    return null
  }
}

function lookupCred(pid: string, service: string, key: string): string | null {
  const botDb = getBotDb()
  if (!botDb) return null
  try {
    const row = botDb
      .prepare('SELECT value, iv, tag FROM project_credentials WHERE project_id = ? AND service = ? AND key = ?')
      .get(pid, service, key) as { value: Buffer; iv: Buffer; tag: Buffer } | undefined
    if (!row) return null
    return decryptCred(row.value, row.iv, row.tag)
  } catch {
    return null
  }
}

// Cache YouTube proxy responses to avoid burning API quota on every dashboard refresh.
// Each entry lives for 6 hours; combined with the daily collector this keeps us well
// under the 10k units/day free quota.
const ytProxyCache = new Map<string, { ts: number; payload: unknown }>()
const YT_CACHE_TTL_MS = 6 * 60 * 60 * 1000

function findYouTubeCred(pid: string, kind: 'api_key' | 'channel_id'): string | null {
  if (kind === 'api_key') {
    return lookupCred(pid, 'youtube', 'api_key')
      ?? lookupCred(pid, 'custom', 'youtube_api_key')
      ?? lookupCred(pid, 'custom', 'yt_api_key')
  }
  return lookupCred(pid, 'youtube', 'channel_id')
    ?? lookupCred(pid, 'custom', 'youtube_channel_id')
}

router.get('/metrics/youtube', async (req: Request, res: Response) => {
  const { requestedProjectId } = resolveProjectScope(req)
  const pid = requestedProjectId ?? 'default'
  const channelId: string = findYouTubeCred(pid, 'channel_id')
    ?? process.env.YOUTUBE_CHANNEL_ID
    ?? ''
  const cacheKey = `${pid}:${channelId}`
  try {
  const apiKey: string | null = findYouTubeCred(pid, 'api_key')
    ?? process.env.YOUTUBE_API_KEY
    ?? process.env.YT_API_KEY
    ?? null

  // Serve from cache if available and fresh
  const cached = ytProxyCache.get(cacheKey)
  if (cached && Date.now() - cached.ts < YT_CACHE_TTL_MS) {
    res.json(cached.payload)
    return
  }

  if (!apiKey) {
    // Fall back to stored metrics if no API key configured
    const metrics = getMetrics('youtube', undefined, pid)
    res.json(metrics)
    return
  }
    const url = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet,statistics&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(apiKey)}`
    const ytRes = await quotaFetch('youtube', url, { endpoint: '/youtube/v3/channels' })
    if (!ytRes.ok) {
      logger.warn({ status: ytRes.status }, 'YouTube API returned non-OK status')
      const metrics = getMetrics('youtube', undefined, pid)
      const payload = { channel: null, videos: [], metrics }
      // Cache 403/quota errors too so we don't keep hammering the API
      ytProxyCache.set(cacheKey, { ts: Date.now(), payload })
      res.json(payload)
      return
    }
    const data = await ytRes.json() as Record<string, unknown>
    const items = data.items as { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] | undefined
    const channel = (items && items.length > 0) ? items[0] : null

    // Fetch recent uploads from the channel's uploads playlist
    let videos: unknown[] = []
    try {
      const uploadsPlaylist = items?.[0]?.contentDetails?.relatedPlaylists?.uploads
      if (uploadsPlaylist) {
        const plUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=10&playlistId=${encodeURIComponent(uploadsPlaylist)}&key=${encodeURIComponent(apiKey)}`
        const plRes = await quotaFetch('youtube', plUrl, { endpoint: '/youtube/v3/playlistItems' })
        if (plRes.ok) {
          const plData = await plRes.json() as { items?: { contentDetails?: { videoId?: string } }[] }
          const videoIds = (plData.items ?? [])
            .map(i => i.contentDetails?.videoId)
            .filter((id): id is string => typeof id === 'string')
          if (videoIds.length > 0) {
            const vidUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${encodeURIComponent(videoIds.join(','))}&key=${encodeURIComponent(apiKey)}`
            const vidRes = await quotaFetch('youtube', vidUrl, { endpoint: '/youtube/v3/videos' })
            if (vidRes.ok) {
              const vidData = await vidRes.json() as { items?: unknown[] }
              videos = vidData.items ?? []
            }
          }
        }
      }
    } catch (vidErr) {
      logger.warn({ err: vidErr }, 'YouTube videos fetch failed (channel stats still returned)')
    }

    // Also include stored sparkline metrics
    const metrics = getMetrics('youtube', undefined, pid)
    const payload = { channel, videos, metrics }
    ytProxyCache.set(cacheKey, { ts: Date.now(), payload })
    res.json(payload)
  } catch (err) {
    if (err instanceof QuotaCooldownError) {
      logger.info({ platform: err.platform, retryAt: err.retryAt }, 'YouTube proxy in cooldown, returning stored metrics')
      const metrics = getMetrics('youtube', undefined, pid)
      const payload = { channel: null, videos: [], metrics, cooldown: { until: err.retryAt, reason: err.message } }
      ytProxyCache.set(cacheKey, { ts: Date.now(), payload })
      res.json(payload)
      return
    }
    logger.error({ err }, 'YouTube API proxy fetch failed')
    const metrics = getMetrics('youtube', undefined, pid)
    const payload = { channel: null, videos: [], metrics }
    ytProxyCache.set(cacheKey, { ts: Date.now(), payload })
    res.json(payload)
  }
})

// --- Test Runner ---
// Tests run on the Mac (where the source lives), not on Hostinger.
// Dashboard relays the request to the bot via WebSocket; bot runs vitest and streams results back.

let currentTestRunId: string | null = null

// Called by ws.ts when the bot sends test-update messages back
export function setTestRunInProgress(val: boolean): void {
  if (!val) currentTestRunId = null
}

router.post('/tests/run', requireAdmin, (_req: Request, res: Response) => {
  if (currentTestRunId) {
    res.status(409).json({ error: 'Test run already in progress' })
    return
  }

  const runId = Date.now().toString()
  currentTestRunId = runId
  broadcastTestUpdate({ status: 'running', message: 'Requesting test run from Mac...' })
  broadcastToMac({ type: 'run-tests' })
  res.json({ ok: true, message: 'Test run started' })

  // Safety timeout: if bot doesn't respond within 120s, unlock.
  // Only resets if this specific run is still the active one.
  setTimeout(() => {
    if (currentTestRunId === runId) {
      currentTestRunId = null
      broadcastTestUpdate({ status: 'error', message: 'Test run timed out (no response from bot)' })
    }
  }, 120_000)
})

// --- Plugins ---

router.get('/plugins', (_req: Request, res: Response) => {
  const rows = getAllPlugins()
  const plugins = rows.map((r) => {
    let keywords = []
    try { keywords = JSON.parse(r.keywords || '[]') } catch { /* keep empty */ }
    let dependencies = []
    try { dependencies = JSON.parse(r.dependencies || '[]') } catch { /* keep empty */ }
    return { ...r, keywords, dependencies, enabled: r.enabled === 1 }
  })
  res.json(plugins)
})

router.get('/plugins/:id', (req: Request, res: Response) => {
  const row = getPluginById(param(req, 'id'))
  if (!row) { res.status(404).json({ error: 'Plugin not found' }); return }
  let kw = []
  try { kw = JSON.parse(row.keywords || '[]') } catch { /* keep empty */ }
  let deps = []
  try { deps = JSON.parse(row.dependencies || '[]') } catch { /* keep empty */ }
  res.json({ ...row, keywords: kw, dependencies: deps, enabled: row.enabled === 1 })
})

router.patch('/plugins/:id', requireAdmin, (req: Request, res: Response) => {
  const id = param(req, 'id')
  const { enabled } = req.body as { enabled?: boolean }
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) is required' })
    return
  }
  const updated = updatePluginEnabled(id, enabled)
  if (!updated) { res.status(404).json({ error: 'Plugin not found' }); return }
  res.json({ id, enabled })
})

// --- Webhooks ---

function isInternalUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr)
    const host = u.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true
    if (host === '169.254.169.254') return true  // cloud metadata
    if (host.endsWith('.internal') || host.endsWith('.local')) return true
    // Check RFC 1918 ranges
    const parts = host.split('.').map(Number)
    if (parts.length === 4 && !parts.some(isNaN)) {
      if (parts[0] === 10) return true
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
      if (parts[0] === 192 && parts[1] === 168) return true
    }
    return false
  } catch { return true }
}

const WEBHOOK_EVENT_TYPES = [
  'agent_completed', 'security_finding', 'task_completed', 'guard_blocked',
]

router.get('/webhooks', (req: Request, res: Response) => {
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  res.json(getAllWebhooks(requestedProjectId ?? undefined, allowedProjectIds).map(sanitizeWebhookForResponse))
})

router.get('/webhooks/deliveries', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  res.json(getRecentWebhookDeliveries(limit, requestedProjectId ?? undefined, allowedProjectIds))
})

router.get('/webhooks/events', (_req: Request, res: Response) => {
  res.json(WEBHOOK_EVENT_TYPES)
})

router.post('/webhooks', requireProjectRole('editor'), (req: Request, res: Response) => {
  const { event_type, target_url, secret, project_id } = req.body as {
    event_type: string; target_url: string; secret?: string; project_id?: string
  }

  if (!event_type || !target_url) {
    res.status(400).json({ error: 'event_type and target_url are required' })
    return
  }

  if (!WEBHOOK_EVENT_TYPES.includes(event_type)) {
    res.status(400).json({ error: `Invalid event_type. Must be one of: ${WEBHOOK_EVENT_TYPES.join(', ')}` })
    return
  }

  try {
    new URL(target_url)
  } catch {
    res.status(400).json({ error: 'target_url must be a valid URL' })
    return
  }

  if (isInternalUrl(target_url)) {
    res.status(400).json({ error: 'Webhook URLs cannot target internal/private addresses' })
    return
  }

  const resolvedProjectId = project_id || 'default'
  if (!isValidProjectId(resolvedProjectId)) {
    res.status(400).json({ error: `Invalid project_id: ${resolvedProjectId}` })
    return
  }

  const webhook = {
    id: randomUUID(),
    project_id: resolvedProjectId,
    event_type,
    target_url,
    secret: secret || '',
    active: 1,
    created_at: Date.now(),
  }

  const ok = createWebhookInBotDb(webhook)
  if (!ok) {
    res.status(500).json({ error: 'Failed to create webhook (bot DB unavailable)' })
    return
  }

  res.status(201).json(sanitizeWebhookForResponse(webhook))
})

router.delete(
  '/webhooks/:id',
  requireProjectRoleForResource('editor', (id) => {
    const botDb = getBotDb()
    if (!botDb) return null
    const wh = botDb.prepare('SELECT project_id FROM webhooks WHERE id = ?').get(id) as { project_id: string } | undefined
    return wh?.project_id ?? null
  }),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const deleted = deleteWebhookFromBotDb(id)
  if (!deleted) {
    res.status(404).json({ error: 'Webhook not found' })
    return
  }
  res.json({ ok: true })
})

router.patch(
  '/webhooks/:id/toggle',
  requireProjectRoleForResource('editor', (id) => {
    const botDb = getBotDb()
    if (!botDb) return null
    const wh = botDb.prepare('SELECT project_id FROM webhooks WHERE id = ?').get(id) as { project_id: string } | undefined
    return wh?.project_id ?? null
  }),
  (req: Request, res: Response) => {
  const id = param(req, 'id')
  const { active } = req.body as { active: boolean }
  if (typeof active !== 'boolean') {
    res.status(400).json({ error: 'active (boolean) is required' })
    return
  }
  const updated = toggleWebhookInBotDb(id, active)
  if (!updated) {
    res.status(404).json({ error: 'Webhook not found' })
    return
  }
  res.json({ id, active })
})

router.post(
  '/webhooks/:id/test',
  requireProjectRoleForResource('editor', (id) => {
    const wh = getAllWebhooks().find(w => w.id === id)
    return wh?.project_id ?? null
  }),
  async (req: Request, res: Response) => {
  const id = param(req, 'id')
  const webhooks = getAllWebhooks()
  const wh = webhooks.find(w => w.id === id)
  if (!wh) {
    res.status(404).json({ error: 'Webhook not found' })
    return
  }

  if (isInternalUrl(wh.target_url)) {
    res.status(400).json({ error: 'Webhook URLs cannot target internal/private addresses' })
    return
  }

  // Fire a test payload
  const uuid = randomUUID()
  const payload = JSON.stringify({
    event: wh.event_type,
    timestamp: Date.now(),
    project_id: wh.project_id,
    data: { test: true, message: 'This is a test webhook delivery from ClaudePaw' },
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-ClaudePaw-Event': wh.event_type,
    'X-ClaudePaw-Delivery': uuid,
  }
  if (wh.secret) {
    headers['X-ClaudePaw-Signature'] = createHmac('sha256', wh.secret).update(payload).digest('hex')
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    const resp = await fetch(wh.target_url, {
      method: 'POST', headers, body: payload, signal: controller.signal,
    })
    clearTimeout(timeout)
    res.json({ status_code: resp.status, ok: resp.ok })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    res.json({ status_code: null, ok: false, error: msg })
  }
  },
)

// --- Knowledge Graph ---

router.get('/graph', requireAdmin, (req: Request, res: Response) => {
  const { requestedProjectId } = resolveProjectScope(req)
  const pid = requestedProjectId ?? undefined
  const db = getDb()
  const botDb = getBotDb()

  interface GNode { id: string; type: string; label: string; emoji?: string; color: string; val: number; group?: string; meta?: Record<string, unknown> }
  interface GLink { source: string; target: string; rel: string; color: string; width: number }

  const nodes: GNode[] = []
  const links: GLink[] = []
  const nodeIds = new Set<string>()

  // Colors
  const C = {
    project: '#00d4ff', agent: '#00ff9f', memory: '#a78bfa', task: '#ffaa00', finding: '#ff3355',
    linkProject: 'rgba(0,212,255,0.35)', linkAgent: 'rgba(0,255,159,0.25)',
    linkTask: 'rgba(255,170,0,0.30)', linkFinding: 'rgba(255,51,85,0.30)',
    linkMemory: 'rgba(167,139,250,0.25)',
  }

  // --- keyword map: patterns in task id/prompt -> agent id ---
  const agentKeywords: Record<string, string[]> = {
    auditor: ['security', 'audit', 'scan', 'npm-audit', 'tailscale-health', 'vulnerability', 'auditor'],
    scout: ['trend', 'research', 'youtube-trend', 'content scout', 'topic', 'scout'],
    producer: ['video', 'pipeline', 'producer', 'production', 'youtube-weekly'],
    social: ['linkedin', 'social', 'engagement', 'post'],
    sentinel: ['monitor', 'mention', 'alert', 'sentinel'],
    analyst: ['analytics', 'metric', 'performance', 'analyst'],
    brand: ['brand', 'newsletter', 'asymmetry'],
    advocate: ['advocate', 'devil', 'challenge'],
    builder: ['builder', 'deploy', 'backup', 'infrastructure', 'build'],
    qa: ['test', 'quality', 'review', 'qa'],
  }

  function matchAgent(text: string): string | null {
    const lower = text.toLowerCase()
    // Direct agent name match first
    for (const a of agents) {
      if (lower.includes(a.id) || lower.includes(a.name.toLowerCase())) return a.id
    }
    // Keyword match
    for (const [agentId, keywords] of Object.entries(agentKeywords)) {
      if (keywords.some(k => lower.includes(k))) return agentId
    }
    return null
  }

  // 1. Projects (hub nodes) -- only show filtered project when pid is set
  const allProjects: Array<{ id: string; name: string; display_name: string; icon: string }> = []
  if (botDb) {
    try {
      const rows = botDb.prepare('SELECT id, name, display_name, icon FROM projects').all() as typeof allProjects
      allProjects.push(...rows)
    } catch (err) { logger.warn({ err }, 'graph query failed') }
  }
  if (allProjects.length === 0) {
    allProjects.push({ id: 'default', name: 'default', display_name: 'Personal Assistant', icon: 'layers' })
  }
  const projectList = pid ? allProjects.filter(p => p.id === pid) : allProjects
  if (projectList.length === 0 && pid) {
    projectList.push({ id: pid, name: pid, display_name: pid, icon: 'folder' })
  }

  const fallbackProjectId = projectList[0]?.id || 'default'

  for (const p of projectList) {
    const nid = `project:${p.id}`
    nodes.push({ id: nid, type: 'project', label: p.display_name || p.name, color: C.project, val: 22, group: p.id, meta: {} })
    nodeIds.add(nid)
  }

  // 2. Agents -- connect to their own project
  const agents = pid
    ? db.prepare('SELECT id, name, emoji, role, status, current_task, project_id FROM agents WHERE project_id = ?').all(pid) as Array<{ id: string; name: string; emoji: string; role: string; status: string; current_task: string | null; project_id: string }>
    : db.prepare('SELECT id, name, emoji, role, status, current_task, project_id FROM agents').all() as Array<{ id: string; name: string; emoji: string; role: string; status: string; current_task: string | null; project_id: string }>
  for (const a of agents) {
    const nid = `agent:${a.id}`
    nodes.push({ id: nid, type: 'agent', label: a.name, emoji: a.emoji, color: C.agent, val: 16, group: a.id, meta: { role: a.role, status: a.status, current_task: a.current_task } })
    nodeIds.add(nid)
    // Connect agent to its own project
    const agentProjectNid = `project:${a.project_id || 'default'}`
    const targetProject = nodeIds.has(agentProjectNid) ? agentProjectNid : `project:${projectList[0]?.id || 'default'}`
    links.push({ source: targetProject, target: nid, rel: 'has agent', color: C.linkProject, width: 2 })
  }

  // 3. Scheduled tasks -- connect to matched agent, or main project as fallback
  try {
    const tasks = pid
      ? db.prepare('SELECT id, prompt, schedule, status FROM scheduled_tasks WHERE project_id = ?').all(pid) as Array<{ id: string; prompt: string; schedule: string; status: string }>
      : db.prepare('SELECT id, prompt, schedule, status FROM scheduled_tasks').all() as Array<{ id: string; prompt: string; schedule: string; status: string }>
    for (const t of tasks) {
      const nid = `task:${t.id}`
      const shortLabel = t.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      const label = shortLabel.length > 28 ? shortLabel.substring(0, 28) + '...' : shortLabel
      nodes.push({ id: nid, type: 'task', label, color: C.task, val: 6, meta: { schedule: t.schedule, status: t.status, prompt: t.prompt?.substring(0, 200) } })
      nodeIds.add(nid)

      const agentId = matchAgent(t.id + ' ' + (t.prompt || ''))
      if (agentId && nodeIds.has(`agent:${agentId}`)) {
        links.push({ source: `agent:${agentId}`, target: nid, rel: 'runs', color: C.linkTask, width: 1.2 })
      } else {
        links.push({ source: `project:${fallbackProjectId}`, target: nid, rel: 'schedules', color: C.linkTask, width: 0.8 })
      }
    }
  } catch (err) { logger.warn({ err }, 'graph query failed') }

  // 4. Security findings -- connect to auditor, fall back to project
  try {
    const findings = pid
      ? db.prepare('SELECT id, scanner_id, severity, title, status, target FROM security_findings WHERE project_id = ? ORDER BY rowid DESC LIMIT 100').all(pid) as Array<{ id: number; scanner_id: string; severity: string; title: string; status: string; target: string }>
      : db.prepare('SELECT id, scanner_id, severity, title, status, target FROM security_findings ORDER BY rowid DESC LIMIT 100').all() as Array<{ id: number; scanner_id: string; severity: string; title: string; status: string; target: string }>
    for (const f of findings) {
      const nid = `finding:${f.id}`
      const sevSize = f.severity === 'critical' ? 10 : f.severity === 'high' ? 7 : 4
      nodes.push({ id: nid, type: 'finding', label: f.title?.substring(0, 35) || `Finding #${f.id}`, color: C.finding, val: sevSize, meta: { severity: f.severity, status: f.status, target: f.target, scanner: f.scanner_id } })
      nodeIds.add(nid)

      // All findings connect to auditor (or via scanner_id keyword match)
      const agentId = matchAgent(f.scanner_id || 'security')
      if (agentId && nodeIds.has(`agent:${agentId}`)) {
        links.push({ source: `agent:${agentId}`, target: nid, rel: 'found', color: C.linkFinding, width: 1 })
      } else {
        links.push({ source: `project:${fallbackProjectId}`, target: nid, rel: 'has finding', color: C.linkFinding, width: 0.6 })
      }
    }
  } catch (err) { logger.warn({ err }, 'graph query failed') }

  // 5. Memories -- connect to project via project_id, or main project
  if (botDb) {
    try {
      const memories = botDb.prepare('SELECT id, topic_key, content, sector, project_id FROM memories ORDER BY rowid DESC LIMIT 100').all() as Array<{ id: number; topic_key: string; content: string; sector: string; project_id: string }>
      for (const m of memories) {
        const nid = `memory:${m.id}`
        nodes.push({ id: nid, type: 'memory', label: m.topic_key || `Memory #${m.id}`, color: C.memory, val: 3, meta: { sector: m.sector, content: m.content?.substring(0, 200) } })
        nodeIds.add(nid)

        const projId = m.project_id || fallbackProjectId
        const targetProject = nodeIds.has(`project:${projId}`) ? `project:${projId}` : `project:${fallbackProjectId}`
        links.push({ source: targetProject, target: nid, rel: 'remembers', color: C.linkMemory, width: 0.6 })
      }
    } catch (err) { logger.warn({ err }, 'graph query failed') }
  }

  // Link secondary projects to first project so nothing floats (only in all-projects view)
  if (!pid && projectList.length > 1) {
    const hubProjectId = projectList[0]?.id || 'default'
    for (const p of projectList) {
      if (p.id !== hubProjectId) {
        links.push({ source: `project:${hubProjectId}`, target: `project:${p.id}`, rel: 'includes', color: C.linkProject, width: 1.5 })
      }
    }
  }

  res.json({ nodes, links })
})

// --- Project Integrations ---

router.get('/integrations', (req: Request, res: Response) => {
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  if (requestedProjectId) {
    // Scope middleware already 404's a cross-project requestedProjectId for
    // members, so by the time we get here requestedProjectId is allowed.
    res.json(getProjectIntegrations(requestedProjectId))
    return
  }
  // No explicit project: admins see everything, members see only their
  // allowed set. Passing allowedProjectIds (null for admin, string[] for
  // members) through lets getAllProjectIntegrations apply the scope.
  res.json(getAllProjectIntegrations(allowedProjectIds))
})

// --- Metric Health (self-healing surface) ---
router.get('/metric-health', (req: Request, res: Response) => {
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  res.json(getMetricHealthForProject(requestedProjectId ?? undefined, allowedProjectIds))
})

router.get('/metric-health/degraded', requireAdmin, (_req: Request, res: Response) => {
  res.json(getDegradedMetricHealth())
})

router.get('/projects/:id/integrations', requireProjectRead('id'), (req: Request, res: Response) => {
  const id = param(req, 'id')
  res.json(getProjectIntegrations(id))
})

router.post('/projects/:id/integrations', requireProjectRole('editor'), (req: Request, res: Response) => {
  const id = param(req, 'id')
  const { platform, display_name, handle, metric_prefix, config, sort_order } = req.body
  if (!platform || !display_name) {
    res.status(400).json({ error: 'Missing required fields: platform, display_name' })
    return
  }
  upsertProjectIntegration({
    project_id: id,
    platform,
    display_name,
    handle: handle || null,
    metric_prefix: metric_prefix || null,
    config: JSON.stringify(config || {}),
    sort_order: sort_order ?? 0,
    enabled: 1,
    created_at: Date.now(),
  })
  res.json(getProjectIntegrations(id))
})

// IMPORTANT: this route only matches numeric IDs. The OAuth disconnect path
// uses DELETE /integrations/:service (string slug like "google") which is
// registered further down. Without the numeric constraint, Express would
// match "google" here, parseInt() it to NaN, silently delete nothing, and
// the dashboard's Disconnect button would appear to do nothing.
router.delete(/^\/integrations\/(\d+)$/, requireProjectRole('editor', (req) => {
  // The numeric integration ID is in params[0] for regex routes
  const numId = parseInt(req.params[0], 10)
  if (isNaN(numId)) return null
  const row = getDb().prepare('SELECT project_id FROM project_integrations WHERE id = ?').get(numId) as { project_id: string } | undefined
  return row?.project_id ?? null
}), (req: Request, res: Response) => {
  const id = parseInt(req.params[0], 10)
  const deleted = deleteProjectIntegration(id)
  res.json({ deleted })
})

// --- OAuth Integration Routes ---

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  // analytics.readonly is required by the metrics collector so GA4 cards can
  // query runReport on properties the authorizing account has access to.
  // Without this scope the google-analytics service credentials fall out of
  // sync with the account currently signed in via Reconnect.
  'https://www.googleapis.com/auth/analytics.readonly',
]

interface OAuthStatePayload {
  projectId: string
  service: string
  returnUrl?: string
  telegramChatId?: number
  scopes: string[]
}

// New integrations catalog routes (GET /catalog, POST /install/:id, etc)
router.use('/integrations', mountIntegrationsRoutes())

// NOTE: /integrations/status MUST be registered before /integrations/:service to avoid param capture
// project_id is required; admin-only when omitted (cross-project view).
router.get(
  '/integrations/status',
  requireProjectRole('viewer', (req) => (req.query.project_id as string) || null),
  (req: Request, res: Response) => {
  const projectId = req.query.project_id as string | undefined
  if (!projectId) {
    res.status(400).json({ error: 'project_id is required' })
    return
  }
  if (!isValidProjectId(projectId)) {
    res.status(400).json({ error: `Invalid project_id: ${projectId}` })
    return
  }

  const signingSecret = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!signingSecret) {
    res.status(500).json({ error: 'OAuth not configured: CREDENTIAL_ENCRYPTION_KEY missing' })
    return
  }
  const services = listOAuthServices(projectId)
  const integrations: Array<{
    service: string
    account: string
    status: 'connected' | 'disconnected'
    scopes: string[]
    disconnectedAt?: number
  }> = []

  for (const svc of services) {
    const colonIdx = svc.indexOf(':')
    if (colonIdx === -1) continue
    const svcName = svc.substring(0, colonIdx)
    const account = svc.substring(colonIdx + 1)
    const creds = getOAuthServiceCredentials(projectId, svc)
    integrations.push({
      service: svcName,
      account,
      status: (creds.status as 'connected' | 'disconnected') || 'disconnected',
      scopes: creds.scopes ? creds.scopes.split(' ') : [],
      disconnectedAt: creds.disconnected_at ? Number(creds.disconnected_at) : undefined,
    })
  }

  res.json({ integrations })
  },
)

router.get('/integrations/:service/auth', requireProjectRole('editor', (req) => (req.query.project_id as string) ?? null), (req: Request, res: Response) => {
  const service = param(req, 'service')
  const projectId = req.query.project_id as string | undefined
  const returnUrl = (req.query.return_url as string | undefined) || `${req.protocol}://${req.get('host')}/#settings`
  const telegramChatId = req.query.telegram_chat_id ? Number(req.query.telegram_chat_id) : undefined

  if (!projectId) {
    res.status(400).json({ error: 'project_id is required' })
    return
  }
  if (!isValidProjectId(projectId)) {
    res.status(400).json({ error: `Invalid project_id: ${projectId}` })
    return
  }

  if (service !== 'google') {
    res.status(400).json({ error: `Unsupported service: ${service}` })
    return
  }

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    res.status(500).json({ error: 'Google OAuth not configured (missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET)' })
    return
  }

  const signingSecret = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!signingSecret) {
    res.status(500).json({ error: 'OAuth not configured: CREDENTIAL_ENCRYPTION_KEY missing' })
    return
  }
  const jwtSecret = process.env.DASHBOARD_JWT_SECRET
  if (!jwtSecret) {
    return res.status(503).json({ error: 'OAuth not configured: DASHBOARD_JWT_SECRET missing' })
  }
  const baseUrl = process.env.DASHBOARD_URL || `${req.protocol}://${req.get('host')}`
  const redirectUri = `${baseUrl}/api/v1/integrations/${service}/callback`

  const statePayload: OAuthStatePayload = {
    projectId,
    service,
    returnUrl,
    telegramChatId,
    scopes: GOOGLE_SCOPES,
  }
  const state = jwt.sign(statePayload, jwtSecret, { expiresIn: '10m' })

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri)
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    // 'consent select_account' forces Google to show the account picker so the
    // user can switch to a brand account (e.g. ClaudePaw YouTube channel)
    // instead of auto-binding to whoever is currently signed in.
    prompt: 'consent select_account',
    scope: GOOGLE_SCOPES,
    state,
  })

  logger.info({ projectId, service }, 'OAuth flow started')
  res.redirect(authUrl)
})

router.get('/integrations/:service/callback', async (req: Request, res: Response) => {
  const service = param(req, 'service')
  const code = req.query.code as string | undefined
  const state = req.query.state as string | undefined

  if (!code || !state) {
    res.status(400).json({ error: 'code and state are required' })
    return
  }

  const signingSecret = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!signingSecret) {
    res.status(500).json({ error: 'OAuth not configured: CREDENTIAL_ENCRYPTION_KEY missing' })
    return
  }
  const jwtSecret = process.env.DASHBOARD_JWT_SECRET
  if (!jwtSecret) {
    return res.status(503).json({ error: 'OAuth not configured: DASHBOARD_JWT_SECRET missing' })
  }
  let statePayload: OAuthStatePayload

  try {
    statePayload = jwt.verify(state, jwtSecret) as OAuthStatePayload
  } catch (err) {
    logger.warn({ err }, 'OAuth state verification failed')
    res.status(400).json({ error: 'Invalid or expired state' })
    return
  }

  if (statePayload.service !== service) {
    res.status(400).json({ error: 'Service mismatch in state' })
    return
  }

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    res.status(500).json({ error: 'Google OAuth not configured' })
    return
  }

  const baseUrl = process.env.DASHBOARD_URL || `${req.protocol}://${req.get('host')}`
  const redirectUri = `${baseUrl}/api/v1/integrations/${service}/callback`
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri)

  try {
    const { tokens } = await oauth2Client.getToken(code)
    oauth2Client.setCredentials(tokens)

    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2Client })
    const { data: userInfo } = await oauth2Api.userinfo.get()
    const email = userInfo.email
    if (!email) {
      res.status(400).json({ error: 'Could not retrieve user email from Google' })
      return
    }

    const serviceKey = `${service}:${email}`
    setOAuthCredential(statePayload.projectId, serviceKey, 'access_token', tokens.access_token || '')
    setOAuthCredential(statePayload.projectId, serviceKey, 'refresh_token', tokens.refresh_token || '')
    setOAuthCredential(statePayload.projectId, serviceKey, 'expiry', String(tokens.expiry_date || 0))
    setOAuthCredential(statePayload.projectId, serviceKey, 'scopes', tokens.scope || GOOGLE_SCOPES.join(' '))
    setOAuthCredential(statePayload.projectId, serviceKey, 'account_email', email)
    setOAuthCredential(statePayload.projectId, serviceKey, 'status', 'connected')
    // Broadcast non-sensitive state changes only -- access_token and refresh_token are
    // omitted intentionally. The bot reads credentials via getCredential() from DB when
    // needed; broadcasting plaintext tokens over the WS bus is unnecessary and poor hygiene.
    broadcastCredentialSync(statePayload.projectId, serviceKey, 'expiry', String(tokens.expiry_date || 0))
    broadcastCredentialSync(statePayload.projectId, serviceKey, 'scopes', tokens.scope || GOOGLE_SCOPES.join(' '))
    broadcastCredentialSync(statePayload.projectId, serviceKey, 'account_email', email)
    broadcastCredentialSync(statePayload.projectId, serviceKey, 'status', 'connected')

    logger.info({ projectId: statePayload.projectId, service, email }, 'OAuth tokens stored')

    // Sync to installed_integrations table so the Integrations page reflects the connection
    try {
      const bdbW = getBotDbWrite()
      if (bdbW) {
        bdbW.prepare(`
          INSERT INTO installed_integrations (project_id, integration_id, status, account, last_verified_at, installed_at)
          VALUES (?, ?, 'connected', ?, ?, ?)
          ON CONFLICT(project_id, integration_id) DO UPDATE SET
            status = 'connected', account = excluded.account, last_verified_at = excluded.last_verified_at, last_error = NULL
        `).run(statePayload.projectId, service, email, Date.now(), Date.now())
      }
    } catch (syncErr) {
      logger.warn({ syncErr }, 'Failed to sync OAuth to installed_integrations')
    }

    // Open redirect protection: only allow redirects back to this server's
    // own origin. Reject any return_url that points to a different host.
    const selfOrigin = `${req.protocol}://${req.get('host')}`
    const fallbackReturn = `${selfOrigin}/#integrations`
    let returnUrl: URL
    try {
      returnUrl = new URL(statePayload.returnUrl || fallbackReturn)
      const expectedOrigin = new URL(selfOrigin).origin
      if (returnUrl.origin !== expectedOrigin) {
        logger.warn({ requestedReturn: statePayload.returnUrl, expectedOrigin }, 'OAuth return_url origin mismatch, forcing fallback')
        returnUrl = new URL(fallbackReturn)
      }
    } catch {
      returnUrl = new URL(fallbackReturn)
    }
    returnUrl.searchParams.set('oauth_success', '1')
    returnUrl.searchParams.set('service', service)
    returnUrl.searchParams.set('account', email)

    res.redirect(returnUrl.toString())
  } catch (err) {
    logger.error({ err, service }, 'OAuth token exchange failed')
    res.status(500).json({ error: 'OAuth token exchange failed' })
  }
})

// Server-to-server endpoint: the Mac bot calls this to get a fresh Google
// access token for an existing OAuth connection. Refreshes via
// google-auth-library and persists rotated tokens back to project_credentials.
// Authenticated by the dashboard token middleware (not public).
// project_id comes from query -- viewer role required to prevent cross-project token leakage.
router.get(
  '/integrations/google/access-token',
  requireProjectRole('viewer', (req) => (req.query.project_id as string) || null),
  async (req: Request, res: Response) => {
  const projectId = req.query.project_id as string | undefined
  const account = req.query.account as string | undefined

  if (!projectId || !account) {
    res.status(400).json({ error: 'project_id and account are required' })
    return
  }

  const serviceKey = `google:${account}`
  const creds = getOAuthServiceCredentials(projectId, serviceKey)
  const refreshToken = creds.refresh_token
  if (!refreshToken) {
    res.status(404).json({ error: `No google credentials for ${projectId}/${account}` })
    return
  }

  const cachedAccess = creds.access_token
  const cachedExpiry = Number(creds.expiry || 0)
  // Reuse cached access token if it has more than 60s left.
  if (cachedAccess && cachedExpiry > Date.now() + 60_000) {
    res.json({
      access_token: cachedAccess,
      expiry_date: cachedExpiry,
      email: creds.account_email || account,
    })
    return
  }

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    res.status(500).json({ error: 'Google OAuth not configured' })
    return
  }

  try {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret)
    oauth2Client.setCredentials({ refresh_token: refreshToken })
    const { credentials } = await oauth2Client.refreshAccessToken()

    const newAccess = credentials.access_token || ''
    const newExpiry = credentials.expiry_date || 0
    // Google normally doesn't rotate refresh_token on refresh; preserve existing.
    const newRefresh = credentials.refresh_token || refreshToken

    setOAuthCredential(projectId, serviceKey, 'access_token', newAccess)
    setOAuthCredential(projectId, serviceKey, 'expiry', String(newExpiry))
    if (credentials.refresh_token && credentials.refresh_token !== refreshToken) {
      setOAuthCredential(projectId, serviceKey, 'refresh_token', newRefresh)
    }

    logger.info({ projectId, account }, 'Google access token refreshed')
    res.json({
      access_token: newAccess,
      expiry_date: newExpiry,
      email: creds.account_email || account,
    })
  } catch (err) {
    logger.error({ err, projectId, account }, 'Failed to refresh Google access token')
    res.status(500).json({
      error: 'Failed to refresh Google access token',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
  },
)

router.delete('/integrations/:service', requireProjectRole('editor', (req) => (req.query.project_id as string) ?? null), (req: Request, res: Response) => {
  const service = param(req, 'service')
  const projectId = req.query.project_id as string | undefined
  const account = req.query.account as string | undefined

  if (!projectId) {
    res.status(400).json({ error: 'project_id is required' })
    return
  }

  const serviceKey = account ? `${service}:${account}` : null

  if (serviceKey) {
    deleteOAuthService(projectId, serviceKey)
    broadcastCredentialDelete(projectId, serviceKey)
  } else {
    // Delete all accounts for this service
    const services = listOAuthServices(projectId)
    const prefix = `${service}:`
    for (const svc of services) {
      if (svc.startsWith(prefix)) {
        deleteOAuthService(projectId, svc)
        broadcastCredentialDelete(projectId, svc)
      }
    }
  }

  logger.info({ projectId, service, account }, 'Integration disconnected')
  res.json({ success: true })
})

// --------------- CREDENTIAL MANAGEMENT (write-only, no value exposure) ---------------

const ENV_MAP: Record<string, { service: string; key: string }> = {
  TWITTER_API_KEY: { service: 'twitter', key: 'api_key' },
  TWITTER_API_SECRET: { service: 'twitter', key: 'api_secret' },
  TWITTER_ACCESS_TOKEN: { service: 'twitter', key: 'access_token' },
  TWITTER_ACCESS_SECRET: { service: 'twitter', key: 'access_secret' },
  LINKEDIN_CLIENT_ID: { service: 'linkedin', key: 'client_id' },
  LINKEDIN_CLIENT_SECRET: { service: 'linkedin', key: 'client_secret' },
  LINKEDIN_ACCESS_TOKEN: { service: 'linkedin', key: 'access_token' },
  LINKEDIN_REDIRECT_URI: { service: 'linkedin', key: 'redirect_uri' },
  LINKEDIN_PERSON_URN: { service: 'linkedin', key: 'person_urn' },
  TELEGRAM_BOT_TOKEN: { service: 'telegram', key: 'bot_token' },
  TELEGRAM_ALLOWED_CHAT_IDS: { service: 'telegram', key: 'allowed_chat_ids' },
  GEMINI_API_KEY: { service: 'gemini', key: 'api_key' },
  GOOGLE_CLIENT_ID: { service: 'google', key: 'client_id' },
  GOOGLE_CLIENT_SECRET: { service: 'google', key: 'client_secret' },
  NEWSLETTER_RECIPIENT: { service: 'newsletter', key: 'recipient' },
  GUARD_SIDECAR_URL: { service: 'guard', key: 'sidecar_url' },
}

const PREFIX_MAP: Array<{ prefix: string; service: string }> = [
  { prefix: 'META_', service: 'meta' },
  { prefix: 'FACEBOOK_', service: 'meta' },
  { prefix: 'SHOPIFY_', service: 'shopify' },
  { prefix: 'WORDPRESS_', service: 'wordpress' },
  { prefix: 'SECURITY_', service: 'security' },
]

function parseAndImportEnv(
  projectId: string, envContent: string
): Array<{ env_key: string; service: string; key: string }> {
  const mappings: Array<{ env_key: string; service: string; key: string }> = []
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 1) continue
    const envKey = trimmed.substring(0, eqIdx).trim()
    const envVal = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (!envVal) continue

    let service: string
    let key: string
    if (ENV_MAP[envKey]) {
      service = ENV_MAP[envKey].service
      key = ENV_MAP[envKey].key
    } else {
      const match = PREFIX_MAP.find(p => envKey.startsWith(p.prefix))
      if (match) {
        service = match.service
        key = envKey.substring(match.prefix.length).toLowerCase()
      } else {
        service = 'custom'
        key = envKey
      }
    }
    setProjectCredential(projectId, service, key, envVal)
    mappings.push({ env_key: envKey, service, key })
  }
  return mappings
}

// List credentials (key names + metadata only, never values).
// project_id in query -> viewer on that project; no project_id -> admin-only (cross-project list).
router.get(
  '/credentials',
  (req, res, next) => {
    const pid = req.query.project_id as string | undefined
    if (pid) {
      requireProjectRole('viewer', () => pid)(req, res, next)
    } else {
      requireAdmin(req, res, next)
    }
  },
  (req: Request, res: Response) => {
    const { requestedProjectId } = resolveProjectScope(req)
    if (requestedProjectId) {
      res.json({ credentials: listProjectCredentials(requestedProjectId) })
    } else {
      res.json({ credentials: listAllProjectCredentials() })
    }
  },
)

router.get(
  '/credentials/summary',
  (req, res, next) => {
    const pid = req.query.project_id as string | undefined
    if (pid) {
      requireProjectRole('viewer', () => pid)(req, res, next)
    } else {
      requireAdmin(req, res, next)
    }
  },
  (req: Request, res: Response) => {
    const { requestedProjectId } = resolveProjectScope(req)
    if (requestedProjectId) {
      res.json({ integrations: buildProjectCredentialSummary(requestedProjectId) })
    } else {
      res.json({ projects: buildAllProjectsCredentialSummary() })
    }
  },
)

// Set a single credential (write-only)
router.post('/credentials', requireProjectRole('editor'), (req: Request, res: Response) => {
  const { project_id, service, key, value } = req.body
  if (!project_id || !service || !key || !value) {
    return res.status(400).json({ error: 'project_id, service, key, and value are required' })
  }
  if (!isValidProjectId(project_id)) {
    return res.status(400).json({ error: `Invalid project_id: ${project_id}` })
  }
  if (!/^[a-z0-9][a-z0-9:\-@.]*$/.test(service)) {
    return res.status(400).json({ error: 'Invalid service name format' })
  }
  if (!/^[a-z0-9_]+$/i.test(key)) {
    return res.status(400).json({ error: 'Invalid key name format' })
  }
  try {
    setProjectCredential(project_id, service, key, value)
    broadcastCredentialSync(project_id, service, key)
    res.status(201).json({ ok: true })
  } catch (e: any) {
    logger.error({ err: e }, 'Failed to set credential')
    res.status(500).json({ error: e.message || 'Failed to set credential' })
  }
})

// Delete credential(s)
router.delete('/credentials', requireProjectRole('editor'), (req: Request, res: Response) => {
  const { project_id, service, key } = req.body || {}
  if (!project_id || !service) {
    return res.status(400).json({ error: 'project_id and service are required' })
  }
  if (!isValidProjectId(project_id)) {
    return res.status(400).json({ error: `Invalid project_id: ${project_id}` })
  }
  if (key) {
    deleteProjectCredentialKey(project_id, service, key)
    broadcastCredentialDelete(project_id, service, key)
  } else {
    deleteProjectCredentialService(project_id, service)
    broadcastCredentialDelete(project_id, service)
  }
  res.status(204).end()
})

// Import from .env format
router.post('/credentials/import', requireProjectRole('editor'), (req: Request, res: Response) => {
  const { project_id, env_content } = req.body
  if (!project_id || !env_content) {
    return res.status(400).json({ error: 'project_id and env_content are required' })
  }
  if (!isValidProjectId(project_id)) {
    return res.status(400).json({ error: `Invalid project_id: ${project_id}` })
  }
  try {
    const mappings = parseAndImportEnv(project_id, env_content)
    res.json({ imported: mappings.length, mappings })
  } catch (e: any) {
    logger.error({ err: e }, 'Failed to import credentials')
    res.status(500).json({ error: e.message || 'Import failed' })
  }
})

// ---------------------------------------------------------------------------
// Action items routes
// ---------------------------------------------------------------------------

router.get('/action-items', (req: Request, res: Response) => {
  const bdb = getBotDb()
  if (!bdb) return res.status(503).json({ error: 'bot db unavailable' })
  const { requestedProjectId, allowedProjectIds } = resolveProjectScope(req)
  const statusParam = req.query.status as string | undefined
  const includeArchived = req.query.include_archived === '1'

  const where: string[] = []
  const params: unknown[] = []
  if (requestedProjectId) {
    where.push('project_id = ?')
    params.push(requestedProjectId)
  } else if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) {
      res.json({ items: [] })
      return
    }
    const ph = allowedProjectIds.map(() => '?').join(', ')
    where.push(`project_id IN (${ph})`)
    params.push(...allowedProjectIds)
  }
  if (statusParam) {
    where.push('status = ?')
    params.push(statusParam)
  } else if (!includeArchived) {
    where.push("status != 'archived'")
  }
  const sql = `SELECT * FROM action_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY
    CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
    COALESCE(target_date, 9999999999999),
    created_at DESC`
  const items = bdb.prepare(sql).all(...params) as ActionItemRow[]
  res.json({ items })
})

router.get(
  '/action-items/:id',
  requireProjectRoleForResource('viewer', (id) => {
    const bdb = getBotDb()
    if (!bdb) return null
    const row = bdb.prepare('SELECT project_id FROM action_items WHERE id = ?').get(id) as { project_id: string } | undefined
    return row?.project_id ?? null
  }),
  (req: Request, res: Response) => {
    const bdb = getBotDb()
    if (!bdb) return res.status(503).json({ error: 'bot db unavailable' })
    const id = param(req, 'id')
    const item = bdb.prepare('SELECT * FROM action_items WHERE id = ?').get(id) as ActionItemRow | undefined
    if (!item) return res.status(404).json({ error: 'not found' })
    const comments = bdb.prepare('SELECT * FROM action_item_comments WHERE item_id = ? ORDER BY created_at ASC').all(item.id) as ActionItemCommentRow[]
    const events = bdb.prepare('SELECT * FROM action_item_events WHERE item_id = ? ORDER BY created_at ASC').all(item.id) as ActionItemEventRow[]
    res.json({ item, comments, events })
  },
)

router.post('/action-items/sync', requireProjectRole('editor'), (req: Request, res: Response) => {
  const bdb = getBotDbWrite()
  if (!bdb) return res.status(503).json({ error: 'bot db unavailable' })

  const projectId = req.body?.project_id as string | undefined
  const items = (req.body?.items as ActionItemRow[] | undefined) ?? []
  const comments = (req.body?.comments as ActionItemCommentRow[] | undefined) ?? []
  const events = (req.body?.events as ActionItemEventRow[] | undefined) ?? []

  if (items.length > 500) {
    return res.status(400).json({ error: 'Too many items (max 500)' })
  }

  if (!projectId) return res.status(400).json({ error: 'project_id required' })

  const VALID_SYNC_STATUSES = new Set(['proposed', 'approved', 'in_progress', 'blocked', 'paused', 'completed', 'rejected', 'archived'])
  const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'critical'])
  const invalidItems: Array<{ index: number; reason: string }> = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item.title || typeof item.title !== 'string' || !item.title.trim()) {
      invalidItems.push({ index: i, reason: 'title must be a non-empty string' })
    } else if (!VALID_SYNC_STATUSES.has(item.status as string)) {
      invalidItems.push({ index: i, reason: `status "${item.status}" is not one of: ${[...VALID_SYNC_STATUSES].join(', ')}` })
    } else if (item.priority != null && !VALID_PRIORITIES.has(item.priority as string)) {
      invalidItems.push({ index: i, reason: `priority "${item.priority}" is not one of: ${[...VALID_PRIORITIES].join(', ')}` })
    }
  }
  if (invalidItems.length > 0) {
    return res.status(400).json({ error: 'Invalid items in sync payload', invalid_items: invalidItems })
  }

  const tx = bdb.transaction(() => {
    const existingIds = bdb.prepare('SELECT id FROM action_items WHERE project_id = ?').all(projectId) as Array<{ id: string }>
    const itemIds = existingIds.map(row => row.id)

    if (itemIds.length > 0) {
      const placeholders = itemIds.map(() => '?').join(', ')
      bdb.prepare(`DELETE FROM action_item_comments WHERE item_id IN (${placeholders})`).run(...itemIds)
      bdb.prepare(`DELETE FROM action_item_events WHERE item_id IN (${placeholders})`).run(...itemIds)
    }
    bdb.prepare('DELETE FROM action_items WHERE project_id = ?').run(projectId)

    const insertItem = bdb.prepare(`
      INSERT INTO action_items
        (id, project_id, title, description, status, priority, source, proposed_by,
         assigned_to, executable_by_agent, parent_id, target_date,
         created_at, updated_at, completed_at, archived_at,
         last_run_at, last_run_result, last_run_session)
      VALUES
        (@id, @project_id, @title, @description, @status, @priority, @source, @proposed_by,
         @assigned_to, @executable_by_agent, @parent_id, @target_date,
         @created_at, @updated_at, @completed_at, @archived_at,
         @last_run_at, @last_run_result, @last_run_session)
    `)
    const insertComment = bdb.prepare(`
      INSERT INTO action_item_comments (id, item_id, author, body, created_at)
      VALUES (@id, @item_id, @author, @body, @created_at)
    `)
    const insertEvent = bdb.prepare(`
      INSERT INTO action_item_events (id, item_id, actor, event_type, old_value, new_value, created_at)
      VALUES (@id, @item_id, @actor, @event_type, @old_value, @new_value, @created_at)
    `)

    for (const item of items) insertItem.run(item)
    for (const comment of comments) insertComment.run(comment)
    for (const event of events) insertEvent.run(event)
  })

  tx()
  broadcastActionItemUpdate('sync', projectId)
  res.json({ ok: true, project_id: projectId, items: items.length, comments: comments.length, events: events.length })
})

router.post('/action-items', requireProjectRole('editor'), (req: Request, res: Response) => {
  const bdb = getBotDbWrite()
  if (!bdb) return res.status(503).json({ error: 'bot db unavailable' })
  const b = (req.body ?? {}) as Record<string, unknown>
  const projectId = b.project_id as string | undefined
  const title = b.title as string | undefined
  if (!projectId || !title) {
    return res.status(400).json({ error: 'project_id and title required' })
  }
  if (!isValidProjectId(projectId)) {
    return res.status(400).json({ error: 'Invalid project_id' })
  }
  const proposedBy = (b.proposed_by as string) || 'human'
  const initialStatus: ActionItemStatus = proposedBy === 'human' ? 'approved' : 'proposed'
  const now = Date.now()
  const id = randomUUID()
  const priority = (b.priority as ActionItemPriority) || 'medium'
  const item: ActionItemRow = {
    id,
    project_id: projectId,
    title,
    description: (b.description as string) ?? null,
    status: initialStatus,
    priority,
    source: (b.source as string) || 'dashboard',
    proposed_by: proposedBy,
    assigned_to: (b.assigned_to as string) ?? null,
    executable_by_agent: b.executable_by_agent ? 1 : 0,
    parent_id: (b.parent_id as string) ?? null,
    target_date: (b.target_date as number) ?? null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    archived_at: null,
    last_run_at: null,
    last_run_result: null,
    last_run_session: null,
  }
  bdb.prepare(`
    INSERT INTO action_items
      (id, project_id, title, description, status, priority, source, proposed_by,
       assigned_to, executable_by_agent, parent_id, target_date,
       created_at, updated_at, completed_at, archived_at,
       last_run_at, last_run_result, last_run_session)
    VALUES
      (@id, @project_id, @title, @description, @status, @priority, @source, @proposed_by,
       @assigned_to, @executable_by_agent, @parent_id, @target_date,
       @created_at, @updated_at, @completed_at, @archived_at,
       @last_run_at, @last_run_result, @last_run_session)
  `).run(item)
  bdb.prepare(`INSERT INTO action_item_events (id, item_id, actor, event_type, old_value, new_value, created_at)
               VALUES (?, ?, ?, 'created', NULL, ?, ?)`).run(
    randomUUID(), id, proposedBy, initialStatus, now,
  )
  broadcastActionItemUpdate(id, projectId)
  broadcastToMac({ type: 'action_item_create', item })
  res.json({ id })
})

router.post(
  '/action-items/:id/transition',
  requireProjectRoleForResource('editor', (id) => {
    const bdb = getBotDb()
    if (!bdb) return null
    const row = bdb.prepare('SELECT project_id FROM action_items WHERE id = ?').get(id) as { project_id: string } | undefined
    return row?.project_id ?? null
  }),
  (req: Request, res: Response) => {
  const bdb = getBotDbWrite()
  if (!bdb) return res.status(503).json({ error: 'bot db unavailable' })
  const to = req.body?.to as ActionItemStatus | undefined
  const actor = (req.body?.actor as string) || 'human'
  const reason = req.body?.reason as string | undefined
  if (!to) return res.status(400).json({ error: 'to required' })
  const item = bdb.prepare('SELECT * FROM action_items WHERE id = ?').get(req.params.id) as ActionItemRow | undefined
  if (!item) return res.status(404).json({ error: 'not found' })
  if (!apCanTransition(item.status, to)) {
    return res.status(409).json({ error: `illegal transition ${item.status} to ${to}` })
  }
  const now = Date.now()
  const sets: string[] = ['status = ?', 'updated_at = ?']
  const params: unknown[] = [to, now]
  if (to === 'completed') {
    sets.push('completed_at = ?')
    params.push(now)
  }
  if (to === 'archived') {
    sets.push('archived_at = ?')
    params.push(now)
  }
  params.push(req.params.id)
  bdb.prepare(`UPDATE action_items SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  bdb.prepare(`INSERT INTO action_item_events (id, item_id, actor, event_type, old_value, new_value, created_at)
               VALUES (?, ?, ?, 'status_changed', ?, ?, ?)`).run(
    randomUUID(), item.id, actor, item.status, to, now,
  )
  if (reason) {
    bdb.prepare(`INSERT INTO action_item_comments (id, item_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), item.id, actor, reason, now)
  }
  broadcastActionItemUpdate(item.id, item.project_id)
  broadcastToMac({ type: 'action_item_transition', item_id: item.id, project_id: item.project_id, to, actor, reason: reason ?? null, ts: now })
  res.json({ ok: true })
})

router.patch(
  '/action-items/:id',
  requireProjectRoleForResource('editor', (id) => {
    const bdb = getBotDb()
    if (!bdb) return null
    const row = bdb.prepare('SELECT project_id FROM action_items WHERE id = ?').get(id) as { project_id: string } | undefined
    return row?.project_id ?? null
  }),
  (req: Request, res: Response) => {
  const bdb = getBotDbWrite()
  if (!bdb) return res.status(503).json({ error: 'bot db unavailable' })
  const allowed = ['title', 'description', 'priority', 'assigned_to', 'target_date', 'executable_by_agent'] as const
  const fields: Record<string, unknown> = {}
  const body = (req.body ?? {}) as Record<string, unknown>
  for (const k of allowed) if (k in body) fields[k] = body[k]

  // Handle project_id move separately with validation.
  // SECURITY: the requireProjectRoleForResource('editor', ...) middleware
  // above only verifies the caller has editor on the SOURCE project. When
  // moving to a different project we must also verify they have at least
  // editor on the TARGET project — otherwise an editor on project A can
  // inject items into any project B in the system.
  let newProjectId: string | undefined
  if ('project_id' in body) {
    const pid = body['project_id'] as string
    const projectExists = bdb.prepare('SELECT id FROM projects WHERE id = ?').get(pid)
    if (!projectExists) return res.status(409).json({ error: `project ${pid} not found` })
    if (!req.user?.isAdmin) {
      const role = req.user ? getUserProjectRole(req.user.id, pid) : null
      if (!roleAtLeast(role, 'editor')) {
        return res.status(403).json({ error: `editor role required on target project ${pid}` })
      }
    }
    fields['project_id'] = pid
    newProjectId = pid
  }

  const keys = Object.keys(fields)
  if (keys.length === 0) return res.status(400).json({ error: 'no updatable fields' })
  // Runtime guard: ensure all keys are from the allowlist (defense-in-depth against future changes)
  const safeColumns = new Set([...allowed, 'project_id'])
  if (keys.some(k => !safeColumns.has(k))) return res.status(400).json({ error: 'invalid field' })
  const set = keys.map(k => `${k} = @${k}`).join(', ')
  const itemId = param(req, 'id')

  // Fetch old project_id before updating (needed for move event + old-project broadcast)
  const oldRow = bdb.prepare('SELECT project_id FROM action_items WHERE id = ?').get(itemId) as { project_id: string } | undefined
  if (!oldRow) return res.status(404).json({ error: 'not found' })
  const oldProjectId = oldRow.project_id

  const result = bdb.prepare(`UPDATE action_items SET ${set}, updated_at = @__updated_at WHERE id = @__id`)
    .run({ ...fields, __id: itemId, __updated_at: Date.now() })
  if (result.changes === 0) return res.status(404).json({ error: 'not found' })

  if (newProjectId) {
    // Log a 'moved' event and broadcast to both old and new projects
    bdb.prepare(`INSERT INTO action_item_events (id, item_id, actor, event_type, old_value, new_value, created_at)
                 VALUES (?, ?, ?, 'moved', ?, ?, ?)`)
      .run(randomUUID(), itemId, (body['actor'] as string) || 'human', oldProjectId, newProjectId, Date.now())
    broadcastActionItemUpdate(itemId, oldProjectId)
    broadcastToMac({ type: 'mac_action_item_patch', item_id: itemId, project_id: oldProjectId, fields, ts: Date.now() })
    broadcastActionItemUpdate(itemId, newProjectId)
    broadcastToMac({ type: 'mac_action_item_patch', item_id: itemId, project_id: newProjectId, fields: { project_id: newProjectId }, ts: Date.now() })
  } else {
    broadcastActionItemUpdate(itemId, oldProjectId)
    broadcastToMac({ type: 'mac_action_item_patch', item_id: itemId, project_id: oldProjectId, fields, ts: Date.now() })
  }
  res.json({ ok: true })
})

router.post(
  '/action-items/:id/comments',
  requireProjectRoleForResource('editor', (id) => {
    const bdb = getBotDb()
    if (!bdb) return null
    const row = bdb.prepare('SELECT project_id FROM action_items WHERE id = ?').get(id) as { project_id: string } | undefined
    return row?.project_id ?? null
  }),
  (req: Request, res: Response) => {
  const bdb = getBotDbWrite()
  if (!bdb) return res.status(503).json({ error: 'bot db unavailable' })
  const body = req.body?.body as string | undefined
  const author = (req.body?.author as string) || 'human'
  if (!body) return res.status(400).json({ error: 'body required' })
  const itemId = param(req, 'id')
  const item = bdb.prepare('SELECT id FROM action_items WHERE id = ?').get(itemId)
  if (!item) return res.status(404).json({ error: 'Action item not found' })
  const commentId = randomUUID()
  const commentTs = Date.now()
  bdb.prepare(`INSERT INTO action_item_comments (id, item_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(commentId, itemId, author, body, commentTs)
  const projectRow = bdb.prepare('SELECT project_id FROM action_items WHERE id = ?').get(itemId) as { project_id: string } | undefined
  if (projectRow) {
    broadcastActionItemUpdate(itemId, projectRow.project_id)
    broadcastToMac({ type: 'action_item_comment', item_id: itemId, project_id: projectRow.project_id, comment_id: commentId, author, body, created_at: commentTs })
  }
  res.json({ ok: true })
})

router.delete(
  '/action-items/:id',
  requireProjectRoleForResource('editor', (id) => {
    const bdb = getBotDb()
    if (!bdb) return null
    const row = bdb.prepare('SELECT project_id FROM action_items WHERE id = ?').get(id) as { project_id: string } | undefined
    return row?.project_id ?? null
  }),
  (req: Request, res: Response) => {
  const bdb = getBotDbWrite()
  if (!bdb) return res.status(503).json({ error: 'bot db unavailable' })
  const itemId = param(req, 'id')
  const item = bdb.prepare('SELECT id, status, project_id FROM action_items WHERE id = ?').get(itemId) as { id: string; status: string; project_id: string } | undefined
  if (!item) return res.status(404).json({ error: 'not found' })
  if (item.status !== 'archived') {
    return res.status(409).json({ error: 'Item must be archived before it can be permanently deleted.' })
  }
  const tx = bdb.transaction((id: string) => {
    bdb.prepare('DELETE FROM action_item_comments WHERE item_id = ?').run(id)
    bdb.prepare('DELETE FROM action_item_events   WHERE item_id = ?').run(id)
    bdb.prepare('DELETE FROM action_items          WHERE id      = ?').run(id)
  })
  tx(itemId)
  broadcastActionItemUpdate(itemId, item.project_id)
  broadcastToMac({ type: 'action_item_delete', item_id: itemId, project_id: item.project_id })
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Action item chat
// ---------------------------------------------------------------------------

router.get(
  '/action-items/:id/chat',
  requireProjectRoleForResource('viewer', (id) => {
    const bdb = getBotDb()
    if (!bdb) return null
    const row = bdb.prepare('SELECT project_id FROM action_items WHERE id = ?').get(id) as { project_id: string } | undefined
    return row?.project_id ?? null
  }),
  (req: Request, res: Response) => {
    const id = param(req, 'id')
    const messages = getChatHistory(getDb(), id)
    res.json({ messages })
  },
)

router.post(
  '/action-items/:id/chat',
  requireProjectRoleForResource('editor', (id) => {
    const bdb = getBotDb()
    if (!bdb) return null
    const row = bdb.prepare('SELECT project_id FROM action_items WHERE id = ?').get(id) as { project_id: string } | undefined
    return row?.project_id ?? null
  }),
  (req: Request, res: Response) => {
  const bdb = getBotDbWrite()
  if (!bdb) { res.status(503).json({ error: 'bot db unavailable' }); return }
  const id = param(req, 'id')
  const userMessage: string = req.body?.message ?? ''
  const init: boolean = req.body?.init === true

  const item = bdb.prepare('SELECT * FROM action_items WHERE id = ?').get(id) as ActionItemRow | undefined
  if (!item) { res.status(404).json({ error: 'Action item not found' }); return }

  const context: ActionItemContext = {
    id: item.id,
    title: item.title,
    description: item.description,
    priority: item.priority,
    status: item.status,
    project_id: item.project_id,
  }

  const history = getChatHistory(getDb(), id)

  // Save user message (skipped on init -- no user message to save)
  if (!init && userMessage) {
    const userMsg = makeChatMessage(id, 'user', userMessage)
    saveChatMessage(getDb(), userMsg)
    bdb.prepare(`INSERT INTO action_item_comments (id, item_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(userMsg.id, id, 'you', userMessage, userMsg.created_at)

    if (MEMORY_V2_ENABLED) {
      saveV2ChatMessage({
        chatId: `action-plan:${id}`,
        projectId: item.project_id ?? 'default',
        userId: req.user?.id != null ? String(req.user.id) : null,
        role: 'user',
        content: userMessage,
      })
    }
  }

  // Respond immediately -- agent result comes back via WebSocket
  res.json({ status: 'dispatched' })

  const agentJobId = randomUUID()
  const agentPrompt = buildAgentPrompt(context, history, userMessage, init)

  // Dispatch to Mac bot via WebSocket -- the bot runs runAgent and sends back action_item_chat_result
  broadcastToMac({
    type: 'run_action_item_chat',
    item_id: id,
    project_id: item.project_id,
    prompt: agentPrompt,
    agent_job_id: agentJobId,
  })
})

// REST fallback for action-item chat results (mirrors the WS path in ws.ts).
// The Mac bot POSTs here after sending via WS, so the result is persisted even if WS dropped.
router.post('/action-items/:id/chat/result', requireBotOrAdmin, (req: Request, res: Response) => {
  const bdb = getBotDbWrite()
  if (!bdb) { res.status(503).json({ error: 'bot db unavailable' }); return }
  const itemId = param(req, 'id')
  const { agent_text, agent_job_id, project_id } = req.body as { agent_text?: string; agent_job_id?: string; project_id?: string }
  const text = agent_text ?? 'Agent completed with no output.'

  // Dedup: if the WS path already saved a message for this agent_job_id, skip DB write
  const tdb = getDb()
  const existing = agent_job_id
    ? tdb.prepare('SELECT id FROM action_item_chat_messages WHERE agent_job = ?').get(agent_job_id)
    : null
  if (existing) {
    res.status(200).json({ status: 'already_saved' })
    return
  }

  const agentMsg = makeChatMessage(itemId, 'agent', text, agent_job_id)
  try {
    saveChatMessage(tdb, agentMsg)
    bdb.prepare(`INSERT OR IGNORE INTO action_item_comments (id, item_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(agentMsg.id, itemId, 'agent', text, agentMsg.created_at)
  } catch (err) {
    logger.error({ err, itemId }, 'Failed to save action_item_chat_result via REST')
  }

  if (MEMORY_V2_ENABLED) {
    saveV2ChatMessage({
      chatId: `action-plan:${itemId}`,
      projectId: project_id ?? 'default',
      userId: null,
      role: 'assistant',
      content: text,
    })
  }

  broadcastActionItemChatResult({ item_id: itemId, project_id, message: agentMsg })
  res.status(201).json({ status: 'ok' })
})

router.post('/action-items/purge-stale', requireAdmin, (_req: Request, res: Response) => {
  const bdb = getBotDbWrite()
  if (!bdb) return res.status(503).json({ error: 'bot db unavailable' })
  const THIRTY = 30 * 24 * 60 * 60 * 1000
  const cutoff = Date.now() - THIRTY
  const tx = bdb.transaction((cutoffMs: number) => {
    const rows = bdb.prepare(`
      SELECT id, project_id FROM action_items
       WHERE archived_at IS NOT NULL
         AND archived_at < ?
    `).all(cutoffMs) as { id: string; project_id: string }[]
    if (rows.length === 0) return rows
    const delComments = bdb.prepare('DELETE FROM action_item_comments WHERE item_id = ?')
    const delEvents   = bdb.prepare('DELETE FROM action_item_events   WHERE item_id = ?')
    const delItem     = bdb.prepare('DELETE FROM action_items          WHERE id      = ?')
    for (const row of rows) {
      delComments.run(row.id)
      delEvents.run(row.id)
      delItem.run(row.id)
    }
    return rows
  })
  const purgedRows = tx(cutoff)
  for (const row of purgedRows) {
    broadcastToMac({ type: 'action_item_delete', item_id: row.id, project_id: row.project_id })
  }
  res.json({ purged: purgedRows.length })
})

router.post('/action-items/archive-stale', requireAdmin, (_req: Request, res: Response) => {
  const bdb = getBotDbWrite()
  if (!bdb) return res.status(503).json({ error: 'bot db unavailable' })
  const FOURTEEN = 14 * 24 * 60 * 60 * 1000
  const now = Date.now()
  const cutoff = now - FOURTEEN
  const tx = bdb.transaction((cutoffMs: number) => {
    const rows = bdb.prepare(`
      SELECT id, status, project_id FROM action_items
       WHERE status IN ('completed', 'rejected')
         AND archived_at IS NULL
         AND COALESCE(completed_at, updated_at) < ?
    `).all(cutoffMs) as { id: string; status: string; project_id: string }[]
    if (rows.length === 0) return rows
    const updateStmt = bdb.prepare(`
      UPDATE action_items
         SET status = 'archived', archived_at = ?, updated_at = ?
       WHERE id = ?
    `)
    const eventStmt = bdb.prepare(`
      INSERT INTO action_item_events (id, item_id, actor, event_type, old_value, new_value, created_at)
      VALUES (?, ?, 'system', 'archived', ?, 'archived', ?)
    `)
    for (const row of rows) {
      updateStmt.run(now, now, row.id)
      eventStmt.run(randomUUID(), row.id, row.status, now)
    }
    return rows
  })
  const archivedRows = tx(cutoff)
  for (const row of archivedRows) {
    broadcastActionItemUpdate(row.id, row.project_id)
  }
  res.json({ archived: archivedRows.length })
})

router.get('/knowledge/stats', (req: Request, res: Response) => {
  try {
    // Project-scope: admins see all, members only see knowledge tied to
    // entities whose project_id is in their allowed set. Entities without a
    // project_id (global) are visible to everyone — they are not tenant data.
    const { allowedProjectIds, requestedProjectId } = resolveProjectScope(req)
    if (Array.isArray(allowedProjectIds) && allowedProjectIds.length === 0) {
      res.json({ entityCounts: [], totalObservations: 0, totalRelations: 0, recentObservations: [], recentChanges: [], embeddingDimension: null })
      return
    }

    // Build the entity-scope predicate and its parameter list.
    let entityScope = ''
    const scopeParams: string[] = []
    if (requestedProjectId) {
      if (Array.isArray(allowedProjectIds) && !allowedProjectIds.includes(requestedProjectId)) {
        res.json({ entityCounts: [], totalObservations: 0, totalRelations: 0, recentObservations: [], recentChanges: [], embeddingDimension: null })
        return
      }
      entityScope = '(e.project_id = ? OR e.project_id IS NULL)'
      scopeParams.push(requestedProjectId)
    } else if (Array.isArray(allowedProjectIds)) {
      const placeholders = allowedProjectIds.map(() => '?').join(', ')
      entityScope = `(e.project_id IN (${placeholders}) OR e.project_id IS NULL)`
      scopeParams.push(...allowedProjectIds)
    }

    const botDb = getBotDb()
    if (!botDb) {
      res.json({ entityCounts: [], totalObservations: 0, totalRelations: 0, recentObservations: [], recentChanges: [], embeddingDimension: null })
      return
    }

    // Check tables exist
    const hasEntities = botDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entities'").get()
    if (!hasEntities) {
      res.json({ entityCounts: [], totalObservations: 0, totalRelations: 0, recentObservations: [], recentChanges: [], embeddingDimension: null })
      return
    }

    const entitiesWhere = entityScope ? `WHERE ${entityScope}` : ''
    const entityCounts = botDb
      .prepare(`SELECT type, COUNT(*) as count FROM entities e ${entitiesWhere} GROUP BY type ORDER BY count DESC`)
      .all(...scopeParams) as Array<{ type: string; count: number }>

    const obsBaseWhere = entityScope ? `AND ${entityScope}` : ''
    const totalObservations = (
      botDb.prepare(`
        SELECT COUNT(*) as n FROM observations o JOIN entities e ON e.id = o.entity_id
        WHERE o.valid_until IS NULL ${obsBaseWhere}
      `).get(...scopeParams) as { n: number }
    ).n

    const totalRelations = (
      botDb.prepare(`
        SELECT COUNT(*) as n FROM relations r JOIN entities e ON e.id = r.from_entity_id
        WHERE r.valid_until IS NULL ${obsBaseWhere}
      `).get(...scopeParams) as { n: number }
    ).n

    const recentObservations = botDb
      .prepare(`
        SELECT o.content, o.source, o.confidence, o.created_at, e.name as entity_name
        FROM observations o JOIN entities e ON e.id = o.entity_id
        WHERE o.valid_until IS NULL ${obsBaseWhere}
        ORDER BY o.created_at DESC LIMIT 10
      `)
      .all(...scopeParams)

    const recentChanges = botDb
      .prepare(`
        SELECT o.content, o.valid_until as changed_at, e.name as entity_name
        FROM observations o JOIN entities e ON e.id = o.entity_id
        WHERE o.valid_until IS NOT NULL ${obsBaseWhere}
        ORDER BY o.valid_until DESC LIMIT 5
      `)
      .all(...scopeParams)

    const embeddingDimension = (
      botDb
        .prepare("SELECT value FROM kv_settings WHERE key = 'embedding_dimensions'")
        .get() as { value: string } | undefined
    )?.value ?? null

    res.json({ entityCounts, totalObservations, totalRelations, recentObservations, recentChanges, embeddingDimension })
  } catch (err) {
    logger.error({ err }, 'GET /knowledge-graph/stats failed')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── System Update ──────────────────────────────────────────────────────

router.get('/system/update-status', requireAdmin, async (_req: Request, res: Response) => {
  if (updateStatusCache && Date.now() - updateStatusCache.cachedAt < UPDATE_CACHE_TTL_MS) {
    return res.json(updateStatusCache.data)
  }
  const gitHash = getBotGitHash()
  const status = await getUpdateStatus(gitHash)
  updateStatusCache = { data: status, cachedAt: Date.now() }
  res.json(status)
})

router.post('/system/upgrade', requireAdmin, (_req: Request, res: Response) => {
  const gitHash = getBotGitHash()
  if (!gitHash) {
    return res.status(503).json({ error: 'Bot not connected' })
  }
  broadcastToMac({ type: 'upgrade' })
  updateStatusCache = null // invalidate so badge refreshes after reconnect
  res.status(202).json({ ok: true })
})

// ---------------------------------------------------------------------------
// System state sub-router (kill-switch)
// ---------------------------------------------------------------------------

router.use('/system-state', systemStateRoutes)

// ---------------------------------------------------------------------------
// Cost-gate sub-router
// ---------------------------------------------------------------------------

router.use('/cost-gate', costGateRoutes)

export default router
