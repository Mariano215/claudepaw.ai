import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { logger } from './logger.js'
import {
  updateAgentStatus, getMessagesForAgent, type FeedItem, type Message,
  upsertSecurityFinding, recordSecurityScan, upsertSecurityScore, recordSecurityAutoFix,
  syncScheduledTasks, type ScheduledTask,
  upsertPlugin, insertChannelLog, resetAllActiveAgents, getAllProjectsWithSettings, listAllProjectCredentialValues,
  getBotDbWrite,
} from './db.js'
import { getChatHistory, saveChatMessage, makeChatMessage } from './action-plan-chat.js'
import { verifyWsTicket } from './auth.js'
import { getUserById, getUserProjectIds } from './users.js'

export interface ClientUser {
  id: number
  isAdmin: boolean
  /** null means admin (all projects); non-null array means scoped member */
  allowedProjectIds: string[] | null
}

export interface ConnectedClient {
  ws: WebSocket
  clientId: string
  connectedAt: number
  user?: ClientUser
}

// Per-user connection cap (bot exempt)
const MAX_CONNECTIONS_PER_USER = 10

/**
 * Returns true when a broadcast message should be delivered to `client`.
 * - Bot (mac-primary) and admins see everything.
 * - Messages with no project_id go to everyone (system-level notices).
 * - Members only receive messages for projects they belong to.
 * Exported for testing.
 */
export function canDeliverToClient(client: ConnectedClient, projectId?: string | null): boolean {
  if (client.clientId === BOT_CLIENT_ID) return true
  if (client.user?.isAdmin) return true
  if (!projectId) return true
  const allowed = client.user?.allowedProjectIds
  if (!allowed) return false
  return allowed.includes(projectId)
}

const clients = new Map<string, ConnectedClient>()

// The bot registers with clientId 'mac-primary' -- track it separately for targeted sends
const BOT_CLIENT_ID = 'mac-primary'
let botSocket: WebSocket | null = null

let botGitHash: string | null = null

export function getBotGitHash(): string | null {
  return botGitHash
}

// In-memory rolling window of bot health snapshots (pushed from Mac via WS)
const BOT_HEALTH_MAX = 30
const botHealthSnapshots: Record<string, unknown>[] = []

export function getBotHealthSnapshots(): Record<string, unknown>[] {
  return botHealthSnapshots
}

const MAX_WS_CLIENTS = 50

export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server })

  wss.on('connection', (ws) => {
    if (clients.size >= MAX_WS_CLIENTS) {
      ws.send(JSON.stringify({ type: 'error', reason: 'max connections reached' }))
      ws.close()
      return
    }

    let clientId = `anon-${Date.now()}`
    logger.info('WebSocket client connected')

    // Per-client rate limiting: 60 messages per minute (sliding window).
    // The bot client (mac-primary) is exempt because it legitimately streams
    // high-frequency events. Applies only to other clients.
    const WS_RATE_LIMIT = 60
    const WS_RATE_WINDOW_MS = 60_000
    const messageTimestamps: number[] = []

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping()
      }
    }, 30_000)

    ws.on('message', (raw) => {
      try {
        // Rate limit check (skip for bot client)
        if (clientId !== BOT_CLIENT_ID) {
          const now = Date.now()
          while (messageTimestamps.length && messageTimestamps[0] < now - WS_RATE_WINDOW_MS) {
            messageTimestamps.shift()
          }
          if (messageTimestamps.length >= WS_RATE_LIMIT) {
            ws.send(JSON.stringify({ type: 'error', reason: 'rate limit exceeded' }))
            logger.warn({ clientId, count: messageTimestamps.length }, 'WS rate limit exceeded, dropping message')
            return
          }
          messageTimestamps.push(now)
        }

        const data = JSON.parse(raw.toString())

        // Update clientId if registration.
        // Browser clients send { type: 'register', userTicket } with no clientId; fall back
        // to the anon ID assigned at connection so the user object still gets attached.
        if (data.type === 'register') {
          const incomingClientId = (data.clientId as string | undefined) ?? clientId
          const wsSecret = process.env.WS_SECRET

          // ---------------------------------------------------------------
          // Bot path: mac-primary + HMAC
          // ---------------------------------------------------------------
          if (incomingClientId === BOT_CLIENT_ID) {
            if (wsSecret) {
              const token = data.token as string | undefined
              const ts = data.ts as number | undefined

              if (!token || !ts) {
                ws.send(JSON.stringify({ type: 'auth_error', reason: 'missing token or timestamp' }))
                ws.close(4401, 'unauthenticated')
                return
              }

              const skewMs = Math.abs(Date.now() - ts)
              if (skewMs > 30_000) {
                ws.send(JSON.stringify({ type: 'auth_error', reason: 'timestamp out of range' }))
                ws.close(4401, 'unauthenticated')
                return
              }

              const expected = createHmac('sha256', wsSecret)
                .update(`${incomingClientId}:${ts}`)
                .digest('hex')

              const tokenBuf = Buffer.from(token, 'hex')
              const expectedBuf = Buffer.from(expected, 'hex')
              if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
                ws.send(JSON.stringify({ type: 'auth_error', reason: 'invalid token' }))
                ws.close(4401, 'unauthenticated')
                return
              }
            } else if (process.env.NODE_ENV === 'production') {
              ws.send(JSON.stringify({ type: 'auth_error', reason: 'WS_SECRET required in production' }))
              ws.close(4401, 'unauthenticated')
              return
            } else {
              logger.warn('WS_SECRET not set -- allowing unauthenticated bot connection (dev mode)')
            }

            // Bot is a system user: no per-user cap, no user object needed
            const oldId = clientId
            clientId = incomingClientId
            clients.delete(oldId)
            clients.set(clientId, { ws, clientId, connectedAt: Date.now() })
            botSocket = ws

            try {
              const projects = getAllProjectsWithSettings()
              for (const project of projects) {
                ws.send(JSON.stringify({
                  type: 'project_settings_sync',
                  project_id: project.id,
                  settings: {
                    theme_id: project.theme_id ?? null,
                    primary_color: project.primary_color ?? null,
                    accent_color: project.accent_color ?? null,
                    sidebar_color: project.sidebar_color ?? null,
                    execution_provider: project.execution_provider ?? null,
                    execution_provider_secondary: project.execution_provider_secondary ?? null,
                    execution_provider_fallback: project.execution_provider_fallback ?? null,
                    execution_model: project.execution_model ?? null,
                    execution_model_primary: project.execution_model_primary ?? null,
                    execution_model_secondary: project.execution_model_secondary ?? null,
                    execution_model_fallback: project.execution_model_fallback ?? null,
                    fallback_policy: project.fallback_policy ?? null,
                    model_tier: project.model_tier ?? null,
                  },
                }))
              }
              logger.info({ count: projects.length }, 'Synced project settings to bot on connect')
            } catch (err) {
              logger.error({ err }, 'Failed to sync project settings to bot on connect')
            }
            try {
              const credentials = listAllProjectCredentialValues()
              for (const credential of credentials) {
                ws.send(JSON.stringify({
                  type: 'project_credential_sync',
                  project_id: credential.project_id,
                  service: credential.service,
                  key: credential.key,
                  value: credential.value,
                  updated_at: credential.updated_at,
                }))
              }
              logger.info({ count: credentials.length }, 'Synced project credentials to bot on connect')
            } catch (err) {
              logger.error({ err }, 'Failed to sync project credentials to bot on connect')
            }

            logger.info({ clientId }, 'Bot registered')
            ws.send(JSON.stringify({ type: 'registered', clientId }))
            return
          }

          // ---------------------------------------------------------------
          // Browser client path: must supply a valid userTicket
          // ---------------------------------------------------------------
          const userTicket = data.userTicket as string | undefined
          if (!userTicket) {
            ws.send(JSON.stringify({ type: 'auth_error', reason: 'userTicket required for browser clients' }))
            ws.close(4401, 'unauthenticated')
            return
          }

          let verifiedUserId: number
          try {
            const verified = verifyWsTicket(userTicket)
            verifiedUserId = verified.userId
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'invalid ticket'
            ws.send(JSON.stringify({ type: 'auth_error', reason: msg }))
            ws.close(4401, 'unauthenticated')
            return
          }

          const dbUser = getUserById(verifiedUserId)
          if (!dbUser) {
            ws.send(JSON.stringify({ type: 'auth_error', reason: 'user not found' }))
            ws.close(4401, 'unauthenticated')
            return
          }

          // Per-user connection cap
          const existingUserConns = Array.from(clients.values()).filter(
            c => c.user?.id === verifiedUserId && c.ws.readyState === WebSocket.OPEN,
          ).length
          if (existingUserConns >= MAX_CONNECTIONS_PER_USER) {
            ws.send(JSON.stringify({ type: 'error', reason: 'too many connections' }))
            ws.close(4429, 'too many connections')
            return
          }

          const isAdmin = dbUser.global_role === 'admin'
          const clientUser: ClientUser = {
            id: verifiedUserId,
            isAdmin,
            allowedProjectIds: isAdmin ? null : getUserProjectIds(verifiedUserId),
          }

          const oldId = clientId
          clientId = incomingClientId
          clients.delete(oldId)
          clients.set(clientId, { ws, clientId, connectedAt: Date.now(), user: clientUser })

          logger.info({ clientId, userId: verifiedUserId, isAdmin }, 'Browser client registered')
          ws.send(JSON.stringify({ type: 'registered', clientId }))
        }

        handleMessage(ws, clientId, data, clients.get(clientId))
      } catch (err) {
        logger.error({ err }, 'Failed to parse WebSocket message')
      }
    })

    ws.on('close', () => {
      clearInterval(pingInterval)
      clients.delete(clientId)
      // Clear bot reference if it was the bot that disconnected
      if (clientId === BOT_CLIENT_ID) {
        botSocket = null
        botGitHash = null
      }
      logger.info({ clientId }, 'Client disconnected')
    })

    ws.on('error', (err) => {
      clearInterval(pingInterval)
      logger.error({ err, clientId }, 'WebSocket error')
    })

    // Store as anonymous until registered
    clients.set(clientId, { ws, clientId, connectedAt: Date.now() })
  })

  logger.info('WebSocket server attached')
  return wss
}

function isAdminOrBot(clientId: string, client: ConnectedClient | undefined): boolean {
  return clientId === BOT_CLIENT_ID || (client?.user?.isAdmin === true)
}

function handleMessage(ws: WebSocket, clientId: string, data: Record<string, unknown>, client?: ConnectedClient): void {
  switch (data.type) {
    case 'register':
      // Handled in the caller
      break

    case 'system-info': {
      if (clientId !== BOT_CLIENT_ID) break
      const hash = data.gitHash
      if (typeof hash === 'string' && hash.length > 0) {
        botGitHash = hash
        logger.info({ gitHash: hash.substring(0, 7) }, 'Bot git hash received')
      }
      break
    }

    case 'agent_status': {
      if (clientId !== BOT_CLIENT_ID) {
        logger.warn({ clientId, type: data.type }, 'Rejected agent_status from non-bot client')
        break
      }
      const agentId = data.agentId as string
      const status = data.status as string
      const task = data.task as string | undefined
      const agentProjectId = (data.project_id ?? data.projectId ?? 'default') as string
      if (agentId && status) {
        updateAgentStatus(agentId, status, task)
        broadcastFeedUpdate({
          id: 0,
          agent_id: agentId,
          action: `status_${status}`,
          detail: task ?? null,
          created_at: Date.now(),
          project_id: agentProjectId,
        })
      }
      break
    }

    case 'security-sync': {
      if (clientId !== BOT_CLIENT_ID) {
        logger.warn({ clientId, type: data.type }, 'Rejected sync from non-bot client')
        break
      }
      const findings = data.findings as Record<string, unknown>[] | undefined
      const scans = data.scans as Record<string, unknown>[] | undefined
      const score = data.score as Record<string, unknown> | undefined
      const autoFixes = data.autoFixes as Record<string, unknown>[] | undefined
      const syncProjectId = (data.project_id ?? data.projectId ?? 'default') as string

      if (Array.isArray(findings)) {
        const bdb = getBotDbWrite()
        if (bdb) {
          const upsertMany = bdb.transaction((fs: Record<string, unknown>[]) => {
            for (const f of fs) {
              upsertSecurityFinding({ ...f, project_id: f.project_id ?? syncProjectId })
            }
          })
          upsertMany(findings)
        } else {
          for (const f of findings) {
            upsertSecurityFinding({ ...f, project_id: f.project_id ?? syncProjectId })
          }
        }
      }
      if (Array.isArray(scans)) {
        for (const s of scans) {
          recordSecurityScan(s, syncProjectId)
        }
      }
      if (score) {
        upsertSecurityScore(score, syncProjectId)
      }
      if (Array.isArray(autoFixes)) {
        for (const af of autoFixes) {
          recordSecurityAutoFix(af, syncProjectId)
        }
      }

      logger.info({
        findings: findings?.length ?? 0,
        scans: scans?.length ?? 0,
        autoFixes: autoFixes?.length ?? 0,
        clientId,
        project_id: syncProjectId,
      }, 'Security sync received')

      // Broadcast security-update to all dashboard clients
      broadcastSecurityUpdate(syncProjectId)
      break
    }

    case 'tasks-sync': {
      if (clientId !== BOT_CLIENT_ID) {
        logger.warn({ clientId, type: data.type }, 'Rejected sync from non-bot client')
        break
      }
      const tasks = data.tasks as ScheduledTask[] | undefined
      const taskProjectId = (data.project_id as string) || 'default'
      if (Array.isArray(tasks)) {
        syncScheduledTasks(tasks, taskProjectId)
        // Notify dashboard clients that tasks changed
        broadcastTasksUpdate(taskProjectId)
      }
      break
    }

    case 'plugins-sync': {
      if (clientId !== BOT_CLIENT_ID) {
        logger.warn({ clientId, type: data.type }, 'Rejected plugins-sync from non-bot client')
        break
      }
      const pluginList = data.plugins as Array<{
        id: string; name: string; version: string; author: string; description: string;
        keywords?: string[]; agent_id?: string; dependencies?: string[]; enabled?: boolean
      }> | undefined
      if (Array.isArray(pluginList)) {
        for (const p of pluginList) {
          upsertPlugin({
            id: p.id, name: p.name, version: p.version, author: p.author,
            description: p.description, keywords: p.keywords ?? [],
            agent_id: p.agent_id, dependencies: p.dependencies ?? [],
            enabled: p.enabled !== false,
          })
        }
        logger.info({ count: pluginList.length }, 'Synced plugins from bot')
      }
      break
    }

    case 'reset_agent_statuses': {
      if (!isAdminOrBot(clientId, client)) {
        logger.warn({ clientId, type: data.type }, 'Rejected reset_agent_statuses: admin or bot required')
        ws.send(JSON.stringify({ type: 'error', reason: 'admin required' }))
        break
      }
      // Bot reconnected -- reset all agents to idle to clear stale "active" statuses
      try {
        const agents = resetAllActiveAgents()
        logger.info('Reset all active agents to idle on bot reconnect')
        const payload = (agentId: string, status: string) =>
          JSON.stringify({ type: 'agent_status', data: { agentId, status, task: null } })
        for (const agent of agents) {
          for (const c of clients.values()) {
            if (c.ws.readyState === WebSocket.OPEN && canDeliverToClient(c, agent.project_id)) {
              c.ws.send(payload(agent.id, agent.status))
            }
          }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to reset agent statuses')
      }
      break
    }

    case 'chat_response': {
      if (clientId !== BOT_CLIENT_ID) {
        logger.warn({ clientId, type: data.type }, 'Rejected chat_response from non-bot client')
        break
      }
      // Bot sends completed chat event -- relay to all dashboard clients
      const chatData = data.data as Record<string, unknown> | undefined
      if (chatData) {
        broadcastChatResponse(chatData)
      }
      break
    }

    case 'feed_item': {
      if (clientId !== BOT_CLIENT_ID) {
        logger.warn({ clientId, type: data.type }, 'Rejected feed_item from non-bot client')
        break
      }
      const feedData = data.data as { agent_id?: string; action?: string; detail?: string; project_id?: string } | undefined
      if (feedData?.agent_id && feedData?.action) {
        broadcastFeedUpdate({
          id: 0,
          agent_id: feedData.agent_id,
          action: feedData.action,
          detail: feedData.detail ?? null,
          created_at: Date.now(),
          project_id: feedData.project_id ?? 'default',
        })
      }
      break
    }

    case 'channel_log': {
      if (clientId !== BOT_CLIENT_ID) {
        logger.warn({ clientId, type: data.type }, 'Rejected channel_log from non-bot client')
        break
      }
      const logEntry = data.data as Record<string, unknown> | undefined
      if (logEntry) {
        insertChannelLog(logEntry)
        broadcastChannelLog(logEntry)
      }
      break
    }

    case 'bot-health': {
      if (clientId !== BOT_CLIENT_ID) {
        logger.warn({ clientId, type: data.type }, 'Rejected health update from non-bot client')
        break
      }
      const snapshot = data.data as Record<string, unknown> | undefined
      if (snapshot) {
        botHealthSnapshots.push(snapshot)
        if (botHealthSnapshots.length > BOT_HEALTH_MAX) botHealthSnapshots.shift()
      }
      break
    }

    case 'test-update': {
      if (clientId !== BOT_CLIENT_ID) {
        logger.warn({ clientId, type: data.type }, 'Rejected test-update from non-bot client')
        break
      }
      const testData = data.data as Record<string, unknown> | undefined
      if (testData) {
        // Unlock the test runner if the run is complete
        const status = testData.status as string | undefined
        if (status === 'passed' || status === 'failed' || status === 'error') {
          import('./routes.js').then(({ setTestRunInProgress }) => {
            setTestRunInProgress(false)
          }).catch(() => {})
        }
        broadcastTestUpdate(testData)
      }
      break
    }

    case 'action_item_chat_result': {
      if (clientId !== BOT_CLIENT_ID) {
        logger.warn({ clientId, type: data.type }, 'Rejected action_item_chat_result from non-bot client')
        break
      }
      const itemId = data.item_id as string | undefined
      const resultProjectId = data.project_id as string | undefined
      const agentJobId = data.agent_job_id as string | undefined
      const agentText = (data.agent_text as string | undefined) ?? 'Agent completed with no output.'
      if (!itemId) break

      const bdbRef = getBotDbWrite()
      if (bdbRef) {
        const agentMsg = makeChatMessage(itemId, 'agent', agentText, agentJobId)
        try {
          saveChatMessage(bdbRef, agentMsg)
          bdbRef.prepare(`INSERT INTO action_item_comments (id, item_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)`)
            .run(agentMsg.id, itemId, 'agent', agentText, agentMsg.created_at)
        } catch (err) {
          logger.error({ err, itemId }, 'Failed to save action_item_chat_result to DB')
        }
        // Broadcast to all dashboard clients (browser windows)
        const payload = JSON.stringify({
          type: 'action_item_chat_agent_result',
          item_id: itemId,
          project_id: resultProjectId,
          message: agentMsg,
        })
        for (const client of clients.values()) {
          if (client.ws.readyState === WebSocket.OPEN && canDeliverToClient(client, resultProjectId)) {
            client.ws.send(payload)
          }
        }
      }
      break
    }

    case 'research_draft_ready': {
      if (clientId !== BOT_CLIENT_ID) {
        logger.warn({ clientId, type: data.type }, 'Rejected research_draft_ready from non-bot client')
        break
      }
      // TODO: bot should forward project_id here so this broadcast can be project-scoped.
      // Today the payload lacks project_id, so canDeliverToClient returns true for all clients.
      broadcastResearchDraftReady({
        item_id: data.research_item_id,
        action_item: data.action_item,
      })
      break
    }

    case 'research_chat_result': {
      if (clientId !== BOT_CLIENT_ID) {
        logger.warn({ clientId, type: data.type }, 'Rejected research_chat_result from non-bot client')
        break
      }
      const researchItemId = data.item_id as string | undefined
      const researchProjectId = data.project_id as string | undefined
      const researchAgentJobId = data.agent_job_id as string | undefined
      const researchAgentText = (data.agent_text as string | undefined) ?? ''
      broadcastResearchChatResult({
        item_id: researchItemId,
        project_id: researchProjectId,
        message: {
          id: `bot-${researchAgentJobId}`,
          item_id: researchItemId,
          role: 'agent',
          body: researchAgentText,
          agent_job: researchAgentJobId,
          created_at: Date.now(),
        },
      })
      break
    }

    case 'paws-update': {
      if (clientId !== BOT_CLIENT_ID) { ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' })); break }
      const pawsProjectId = data.project_id as string | undefined
      broadcastPawsUpdate(pawsProjectId ?? 'default')
      break
    }

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
      break

    default:
      logger.warn({ type: data.type, clientId }, 'Unknown WebSocket message type')
  }
}

export function notifyAgentMessage(agentId: string, message: Message): void {
  // Scope the fanout by the message's project_id so a member on project A
  // doesn't receive push events for project B's inter-agent traffic. If the
  // row has no project_id (legacy rows), fall back to null which delivers to
  // clients without a project filter (dashboards in "All Projects" view).
  const projectId = typeof (message as Message & { project_id?: string }).project_id === 'string'
    ? (message as Message & { project_id?: string }).project_id ?? null
    : null
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN && canDeliverToClient(client, projectId)) {
      client.ws.send(JSON.stringify({
        type: 'new_message',
        agentId,
        message,
      }))
    }
  }
}

export function broadcastFeedUpdate(item: FeedItem): void {
  const payload = JSON.stringify({ type: 'feed_update', item })
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN && canDeliverToClient(client, item.project_id)) {
      client.ws.send(payload)
    }
  }
}

export function getConnectedClients(): { clientId: string; connectedAt: number }[] {
  return Array.from(clients.values()).map(c => ({
    clientId: c.clientId,
    connectedAt: c.connectedAt,
  }))
}

export function isBotConnected(): boolean {
  return Boolean(botSocket && botSocket.readyState === WebSocket.OPEN)
}

/** Send a message to the Mac bot only (registered as 'mac-primary'). */
export function broadcastToMac(message: Record<string, unknown>): void {
  if (botSocket && botSocket.readyState === WebSocket.OPEN) {
    botSocket.send(JSON.stringify(message))
  } else {
    logger.warn({ type: message.type }, 'broadcastToMac: bot not connected')
  }
}

/** Broadcast a chat response event to all dashboard clients. */
export function broadcastChatResponse(event: Record<string, unknown>): void {
  const projectId = typeof event.project_id === 'string' ? event.project_id : null
  const payload = JSON.stringify({ type: 'chat_response', data: event })
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN && canDeliverToClient(client, projectId)) {
      client.ws.send(payload)
    }
  }
}

/** Broadcast a security-update event to all dashboard clients. */
function broadcastSecurityUpdate(projectId: string = 'default'): void {
  const payload = JSON.stringify({ type: 'security-update', ts: Date.now(), project_id: projectId })
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN && canDeliverToClient(client, projectId)) {
      client.ws.send(payload)
    }
  }
}

export function broadcastPawsUpdate(projectId: string = 'default'): void {
  const payload = JSON.stringify({ type: 'paws-update', ts: Date.now(), project_id: projectId })
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN && canDeliverToClient(client, projectId)) {
      client.ws.send(payload)
    }
  }
}

/** Broadcast a tasks-update event to all dashboard clients. */
function broadcastTasksUpdate(projectId: string = 'default'): void {
  const payload = JSON.stringify({ type: 'tasks-update', ts: Date.now(), project_id: projectId })
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN && canDeliverToClient(client, projectId)) {
      client.ws.send(payload)
    }
  }
}

/** Broadcast test runner progress/results to all dashboard clients. */
export function broadcastTestUpdate(data: Record<string, unknown>): void {
  const payload = JSON.stringify({ type: 'test-update', data, ts: Date.now() })
  // test-update is a system-level event (no project_id) -- goes to everyone
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN && canDeliverToClient(client, null)) {
      client.ws.send(payload)
    }
  }
}

/** Broadcast a new channel log entry to all dashboard clients. */
export function broadcastChannelLog(entry: Record<string, unknown>): void {
  const projectId = typeof entry.project_id === 'string' ? entry.project_id : null
  const payload = JSON.stringify({ type: 'channel_log', data: entry })
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN && canDeliverToClient(client, projectId)) {
      client.ws.send(payload)
    }
  }
}

/** Broadcast an action-item chat agent result to all dashboard clients. */
export function broadcastActionItemChatResult(payload: Record<string, unknown>): void {
  const projectId = typeof payload.project_id === 'string' ? payload.project_id : null
  const msg = JSON.stringify({ type: 'action_item_chat_agent_result', ...payload })
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN && canDeliverToClient(client, projectId)) {
      client.ws.send(msg)
    }
  }
}

export function broadcastActionItemUpdate(itemId: string, projectId: string): void {
  const payload = JSON.stringify({
    type: 'action_item_update',
    item_id: itemId,
    project_id: projectId,
    ts: Date.now(),
  })
  for (const client of clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN && canDeliverToClient(client, projectId)) {
      client.ws.send(payload)
    }
  }
}

export function broadcastResearchChatResult(payload: Record<string, unknown>): void {
  const projectId = typeof payload.project_id === 'string' ? payload.project_id : null
  const msg = JSON.stringify({ type: 'research_chat_agent_result', ...payload })
  for (const c of clients.values()) {
    if (c.ws.readyState === WebSocket.OPEN && canDeliverToClient(c, projectId)) c.ws.send(msg)
  }
}

export function broadcastResearchInvestigationComplete(payload: Record<string, unknown>): void {
  const projectId = typeof payload.project_id === 'string' ? payload.project_id : null
  const msg = JSON.stringify({ type: 'research_investigation_complete', ...payload })
  for (const c of clients.values()) {
    if (c.ws.readyState === WebSocket.OPEN && canDeliverToClient(c, projectId)) c.ws.send(msg)
  }
}

export function broadcastResearchDraftReady(payload: Record<string, unknown>): void {
  const projectId = typeof payload.project_id === 'string' ? payload.project_id : null
  const msg = JSON.stringify({ type: 'research_draft_ready', ...payload })
  for (const c of clients.values()) {
    if (c.ws.readyState === WebSocket.OPEN && canDeliverToClient(c, projectId)) c.ws.send(msg)
  }
}

export function broadcastResearchDeleted(payload: Record<string, unknown>): void {
  const projectId = typeof payload.project_id === 'string' ? payload.project_id : null
  const msg = JSON.stringify({ type: 'research_deleted', ...payload })
  for (const c of clients.values()) {
    if (c.ws.readyState === WebSocket.OPEN && canDeliverToClient(c, projectId)) c.ws.send(msg)
  }
}
