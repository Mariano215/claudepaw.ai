import WebSocket from 'ws'
import { createHmac } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.js'
import { executeSecurityScan, executeSingleScan } from './security/index.js'
import { ALLOWED_CHAT_ID, DASHBOARD_API_TOKEN, BOT_API_TOKEN, DASHBOARD_URL as DASHBOARD_BASE_URL, WS_SECRET } from './config.js'
import { runAgent } from './agent.js'
import { upsertProjectSettings, insertActionItem, updateActionItemFields, insertActionItemEvent, insertActionItemComment, getActionItem, deleteActionItem, pauseTask, resumeTask, getTask, createTask, deleteTask, type ActionItem, type ActionItemComment, type ActionItemEvent } from './db.js'
import { setCredential, deleteCredential, deleteService } from './credentials.js'
import { loadHotContext } from './pipeline.js'

// ---------------------------------------------------------------------------
// Dashboard WebSocket client
// Connects ClaudePaw (Mac) to the coordination server (Hostinger)
// Reports agent activity, feeds, and metrics in real-time
// ---------------------------------------------------------------------------

const DASHBOARD_WS_URL = DASHBOARD_BASE_URL ? DASHBOARD_BASE_URL.replace(/^http(s?):\/\//, 'ws$1://') : ''
const RECONNECT_DELAY = 5000
const HEARTBEAT_INTERVAL = 25000

let ws: WebSocket | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let connected = false

// ---------------------------------------------------------------------------
// Dashboard send function (wired from index.ts after bot creation)
// ---------------------------------------------------------------------------

let dashboardSendFn: ((chatId: string, text: string) => Promise<void>) | null = null

export function setDashboardSendFn(fn: (chatId: string, text: string) => Promise<void>): void {
  dashboardSendFn = fn
}

// Bot-to-dashboard callbacks use BOT_API_TOKEN when set.
// BOT_API_TOKEN already falls back to DASHBOARD_API_TOKEN in config.ts, so
// this function always has the right token without extra branching.
function dashboardApiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra }
  if (BOT_API_TOKEN) {
    headers['x-dashboard-token'] = BOT_API_TOKEN
  }
  return headers
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

export function connectDashboard(): void {
  if (!DASHBOARD_BASE_URL) {
    logger.info('No DASHBOARD_URL configured -- dashboard features disabled')
    return
  }
  if (!WS_SECRET || WS_SECRET.trim() === '') {
    logger.error({ msg: 'WS_SECRET is not set -- refusing to connect to dashboard. Set WS_SECRET in .env' })
    return
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }

  try {
    ws = new WebSocket(DASHBOARD_WS_URL)

    ws.on('open', () => {
      connected = true
      logger.info({ url: DASHBOARD_WS_URL }, 'Connected to dashboard server')

      // Register this client with HMAC auth token
      const ts = Date.now()
      const hmac = createHmac('sha256', WS_SECRET)
        .update(`mac-primary:${ts}`)
        .digest('hex')
      send({ type: 'register', clientId: 'mac-primary', token: hmac, ts })

      // Inform dashboard of current git hash so it can check for updates
      try {
        const gitHash = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
        send({ type: 'system-info', gitHash })
      } catch (err) {
        logger.warn({ err }, 'Failed to read git hash for system-info')
      }

      // Reset all agent statuses to idle on connect.
      // Prevents stale "in-progress" agents after crash/restart.
      send({ type: 'reset_agent_statuses' })

      // Sync scheduled tasks on connect (grouped by project)
      try {
        // Delay import to avoid circular deps (scheduler imports dashboard)
        import('./db.js').then(({ listTasks }) => {
          const tasks = listTasks()
          // Group by project_id to preserve per-project scoping on the server
          const byProject = new Map<string, typeof tasks>()
          for (const t of tasks) {
            const pid = t.project_id || 'default'
            if (!byProject.has(pid)) byProject.set(pid, [])
            byProject.get(pid)!.push(t)
          }
          for (const [pid, projectTasks] of byProject) {
            reportScheduledTasks(projectTasks, pid)
          }
          logger.info({ count: tasks.length }, 'Synced scheduled tasks to dashboard on connect')
        }).catch(() => { /* silent -- dashboard will get tasks on next scheduler tick */ })
      } catch { /* silent */ }

      try {
        import('./db.js').then(({ listProjects }) => {
          const projects = listProjects()
          for (const project of projects) {
            reportActionPlanSnapshot(project.id)
          }
          logger.info({ count: projects.length }, 'Synced action plan snapshots to dashboard on connect')
        }).catch(() => { /* silent -- action plan sync will retry on next mutation */ })
      } catch { /* silent */ }

      try {
        import('./paws/index.js').then(({ listPaws, getLatestCycle }) => {
          const paws = listPaws()
          if (paws.length) {
            const cycles = paws
              .map(p => {
                const c = getLatestCycle(p.id)
                return c ? {
                  id: c.id, paw_id: c.paw_id, started_at: c.started_at, phase: c.phase,
                  state: typeof c.state === 'string' ? c.state : JSON.stringify(c.state),
                  findings: typeof c.findings === 'string' ? c.findings : JSON.stringify(c.findings),
                  actions_taken: typeof c.actions_taken === 'string' ? c.actions_taken : JSON.stringify(c.actions_taken),
                  report: c.report, completed_at: c.completed_at, error: c.error,
                } : null
              })
              .filter(Boolean)
            fetch(`${DASHBOARD_BASE_URL}/api/v1/internal/paws-sync`, {
              method: 'POST',
              headers: dashboardApiHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ paws, cycles }),
            }).catch(() => {})
            logger.info({ count: paws.length }, 'Synced paws to dashboard on connect')
          }
        }).catch(() => {})
      } catch { /* silent */ }

      // Start heartbeat
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.ping()
        }
      }, HEARTBEAT_INTERVAL)
    })

    ws.on('close', () => {
      connected = false
      cleanup()
      logger.debug('Dashboard connection closed, reconnecting...')
      scheduleReconnect()
    })

    ws.on('error', (err) => {
      logger.debug({ err: err.message }, 'Dashboard WebSocket error')
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        handleServerMessage(msg)
      } catch {
        // Ignore non-JSON messages
      }
    })
  } catch (err) {
    logger.error({ err }, 'Failed to connect to dashboard')
    scheduleReconnect()
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectDashboard()
  }, RECONNECT_DELAY)
}

function cleanup(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function send(data: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function reportDashboardChatResponse(event: {
  chatId: string
  projectId: string
  promptText?: string
  resultText: string
  isError?: boolean
  agentId?: string | null
}): void {
  const payload = {
    event_id: `dashboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    received_at: Date.now(),
    prompt_text: event.promptText ?? null,
    result_text: event.resultText,
    source: 'dashboard',
    model: null,
    duration_ms: 0,
    total_cost_usd: 0,
    is_error: event.isError ? 1 : 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    agent_id: event.agentId ?? null,
    project_id: event.projectId,
    chat_id: event.chatId,
  }

  // Primary: WebSocket (fast path)
  send({ type: 'chat_response', data: payload })

  // Fallback: REST POST -- ensures delivery if WS drops during long agent run
  fetch(`${DASHBOARD_BASE_URL}/api/v1/chat/response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(BOT_API_TOKEN ? { 'x-dashboard-token': BOT_API_TOKEN } : {}) },
    body: JSON.stringify(payload),
  }).catch(() => { /* silent fallback */ })
}

function deriveDashboardChatId(projectId?: string): string {
  const normalized = typeof projectId === 'string' && projectId.trim() ? projectId.trim() : 'default'
  return `dashboard:${normalized}`
}

function handleServerMessage(msg: Record<string, unknown>): void {
  // Handle chat messages sent from the dashboard UI
  if (msg.type === 'chat_message') {
    const text = msg.text as string | undefined
    const projectId = (msg.project_id as string | undefined)?.trim() || 'default'
    const chatId = (msg.chatId as string | undefined)?.trim() || deriveDashboardChatId(projectId)
    if (!text || typeof text !== 'string' || !text.trim()) {
      logger.warn({ msg }, 'Received chat_message with no text, ignoring')
      return
    }
    logger.info({ text: text.slice(0, 80), chatId, projectId }, 'Dashboard chat message received')

    // Inject projects/<slug>/context.md so the dashboard chat agent gets the
    // same project context Telegram-routed agents see (sheet IDs, tool paths,
    // account emails, workflow rules). Without this, dashboard chats run a
    // bare claude_desktop session with zero project awareness.
    const hotCtx = loadHotContext(projectId)
    const effectivePrompt = hotCtx ? `${hotCtx}\n\n---\n\n${text.trim()}` : text.trim()

    // Run agent directly with claude_desktop provider -- bypasses processMessage() and LLM routing
    runAgent(
      effectivePrompt,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      { projectId, executionOverride: { provider: 'claude_desktop' } },
    ).then((result) => {
      const responseText = result.text ?? result.emptyReason ?? `Agent task failed (no output). Check bot logs for details.`
      reportDashboardChatResponse({
        chatId,
        projectId,
        promptText: text.trim(),
        resultText: responseText,
        isError: !result.text,
        agentId: null,
      })
    }).catch((err: unknown) => {
      logger.error({ err }, '[chat_message] runAgent error')
      reportDashboardChatResponse({
        chatId,
        projectId,
        promptText: text.trim(),
        resultText: err instanceof Error ? err.message : String(err),
        isError: true,
        agentId: null,
      })
    })
    return
  }

  if (msg.type === 'project_settings_sync') {
    const projectId = (msg.project_id as string | undefined)?.trim()
    const settings = msg.settings as Record<string, unknown> | undefined
    if (!projectId || !settings) {
      logger.warn({ msg }, 'Received invalid project_settings_sync payload')
      return
    }
    try {
      upsertProjectSettings({
        project_id: projectId,
        theme_id: settings.theme_id as string | null | undefined,
        primary_color: settings.primary_color as string | null | undefined,
        accent_color: settings.accent_color as string | null | undefined,
        sidebar_color: settings.sidebar_color as string | null | undefined,
        logo_path: settings.logo_path as string | null | undefined,
        execution_provider: settings.execution_provider as string | null | undefined,
        execution_provider_secondary: settings.execution_provider_secondary as string | null | undefined,
        execution_provider_fallback: settings.execution_provider_fallback as string | null | undefined,
        execution_model: settings.execution_model as string | null | undefined,
        execution_model_primary: settings.execution_model_primary as string | null | undefined,
        execution_model_secondary: settings.execution_model_secondary as string | null | undefined,
        execution_model_fallback: settings.execution_model_fallback as string | null | undefined,
        fallback_policy: settings.fallback_policy as string | null | undefined,
        model_tier: settings.model_tier as string | null | undefined,
      })
      logger.info({ projectId }, 'Project settings synced from dashboard server')
    } catch (err) {
      logger.error({ err, projectId }, 'Failed to sync project settings from dashboard server')
    }
    return
  }

  if (msg.type === 'project_credential_sync') {
    const projectId = (msg.project_id as string | undefined)?.trim()
    const service = (msg.service as string | undefined)?.trim()
    const key = (msg.key as string | undefined)?.trim()
    const value = typeof msg.value === 'string' ? msg.value : undefined
    if (!projectId || !service || !key || value === undefined) {
      logger.warn({ msg }, 'Received invalid project_credential_sync payload')
      return
    }
    try {
      setCredential(projectId, service, key, value)
      logger.info({ projectId, service, key }, 'Project credential synced from dashboard server')
    } catch (err) {
      logger.error({ err, projectId, service, key }, 'Failed to sync project credential from dashboard server')
    }
    return
  }

  if (msg.type === 'project_credential_delete') {
    const projectId = (msg.project_id as string | undefined)?.trim()
    const service = (msg.service as string | undefined)?.trim()
    const key = (msg.key as string | undefined)?.trim()
    if (!projectId || !service) {
      logger.warn({ msg }, 'Received invalid project_credential_delete payload')
      return
    }
    try {
      if (key) deleteCredential(projectId, service, key)
      else deleteService(projectId, service)
      logger.info({ projectId, service, key }, 'Project credential deletion synced from dashboard server')
    } catch (err) {
      logger.error({ err, projectId, service, key }, 'Failed to sync project credential deletion from dashboard server')
    }
    return
  }

  // Handle task status changes from the dashboard (pause/resume)
  if (msg.type === 'task-status') {
    const taskId = msg.taskId as string | undefined
    const status = msg.status as string | undefined
    if (!taskId || !status) return

    if (status === 'paused') {
      pauseTask(taskId)
      logger.info({ taskId }, 'Task paused via dashboard')
    } else if (status === 'active') {
      // Dynamic import to avoid circular dep: scheduler imports dashboard
      import('./scheduler.js').then(({ computeNextRun }) => {
        const task = getTask(taskId)
        if (task) {
          const nextRun = computeNextRun(task.schedule)
          resumeTask(taskId, nextRun)
          logger.info({ taskId, nextRun }, 'Task resumed via dashboard')
        }
      }).catch((err) => {
        logger.error({ err }, 'Failed to import scheduler for task resume')
      })
    }
    return
  }

  // Handle run-task triggers from the dashboard
  if (msg.type === 'run-task') {
    const taskId = msg.taskId as string | undefined
    if (!taskId) return

    logger.info({ taskId }, 'Run-task trigger received from dashboard')

    import('./db.js').then(({ getTask }) => {
      const task = getTask(taskId)
      if (!task) {
        logger.warn({ taskId }, 'Run-task: task not found')
        return
      }

      // Execute via the scheduler's runDueTasks path
      import('./scheduler.js').then(({ runTaskNow }) => {
        if (dashboardSendFn) {
          runTaskNow(task, dashboardSendFn).catch((err) => {
            logger.error({ err, taskId }, 'Run-task execution failed')
          })
        }
      }).catch((err) => {
        logger.error({ err }, 'Failed to import scheduler for run-task')
      })
    }).catch((err) => {
      logger.error({ err }, 'Failed to import db for run-task')
    })
    return
  }

  // Handle task CRUD from dashboard
  if (msg.type === 'task-created') {
    const data = msg.data as { id?: string; chat_id?: string; prompt?: string; schedule?: string; project_id?: string } | undefined
    if (!data?.id || !data.prompt || !data.schedule) return
    try {
      createTask(data.id, data.chat_id || '', data.prompt, data.schedule, 0, data.project_id || 'default')
      import('./scheduler.js').then(({ computeNextRun }) => {
        const nextRun = computeNextRun(data.schedule!)
        resumeTask(data.id!, nextRun)
        logger.info({ taskId: data.id }, 'Task created via dashboard')
      }).catch(() => {})
    } catch (err) {
      logger.error({ err, taskId: data.id }, 'Failed to create task from dashboard')
    }
    return
  }

  if (msg.type === 'task-updated') {
    const taskId = msg.taskId as string | undefined
    const data = msg.data as { prompt?: string; schedule?: string; chat_id?: string } | undefined
    if (!taskId || !data) return
    try {
      import('./db.js').then(({ getDb }) => {
        const db = getDb()
        const sets: string[] = []
        const values: unknown[] = []
        if (data.prompt !== undefined) { sets.push('prompt = ?'); values.push(data.prompt) }
        if (data.schedule !== undefined) { sets.push('schedule = ?'); values.push(data.schedule) }
        if (data.chat_id !== undefined) { sets.push('chat_id = ?'); values.push(data.chat_id) }
        if (sets.length) {
          values.push(taskId)
          db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
        }
        if (data.schedule) {
          import('./scheduler.js').then(({ computeNextRun }) => {
            const nextRun = computeNextRun(data.schedule!)
            db.prepare('UPDATE scheduled_tasks SET next_run = ? WHERE id = ?').run(nextRun, taskId)
          }).catch(() => {})
        }
        logger.info({ taskId }, 'Task updated via dashboard')
      }).catch((err) => {
        logger.error({ err, taskId }, 'Failed to update task from dashboard')
      })
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to update task from dashboard')
    }
    return
  }

  if (msg.type === 'task-deleted') {
    const taskId = msg.taskId as string | undefined
    if (!taskId) return
    try {
      deleteTask(taskId)
      logger.info({ taskId }, 'Task deleted via dashboard')
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to delete task from dashboard')
    }
    return
  }

  // Handle paw CRUD from dashboard
  if (msg.type === 'paw-created') {
    const data = msg.data as Record<string, unknown> | undefined
    if (!data?.id) return
    try {
      import('./paws/index.js').then(({ createPaw }) => {
        createPaw({
          id: data.id as string,
          project_id: (data.project_id as string) || 'default',
          name: (data.name as string) || '',
          agent_id: (data.agent_id as string) || '',
          cron: (data.cron as string) || '',
          config: (data.config as any) || { chat_id: '', approval_threshold: 7, approval_timeout_sec: 3600 },
        })
        logger.info({ pawId: data.id }, 'Paw created via dashboard')
      }).catch((err) => {
        logger.error({ err }, 'Failed to create paw from dashboard')
      })
    } catch (err) {
      logger.error({ err }, 'Failed to create paw from dashboard')
    }
    return
  }

  if (msg.type === 'paw-updated') {
    const pawId = msg.pawId as string | undefined
    const data = msg.data as Record<string, unknown> | undefined
    if (!pawId || !data) return
    try {
      import('./paws/db.js').then(({ getPaw, updatePawStatus }) => {
        import('./db.js').then(({ getDb }) => {
          const db = getDb()
          const sets: string[] = []
          const values: unknown[] = []
          if (data.name !== undefined) { sets.push('name = ?'); values.push(data.name as string) }
          if (data.agent_id !== undefined) { sets.push('agent_id = ?'); values.push(data.agent_id as string) }
          if (data.cron !== undefined) { sets.push('cron = ?'); values.push(data.cron as string) }
          if (data.config !== undefined) {
            const existing = db.prepare('SELECT config FROM paws WHERE id = ?').get(pawId) as any
            const existingConfig = existing ? JSON.parse(existing.config) : {}
            const merged = { ...existingConfig, ...(data.config as Record<string, unknown>) }
            sets.push('config = ?')
            values.push(JSON.stringify(merged))
          }
          if (sets.length) {
            values.push(pawId)
            db.prepare(`UPDATE paws SET ${sets.join(', ')} WHERE id = ?`).run(...values)
          }
          if (data.cron) {
            import('./scheduler.js').then(({ computeNextRun }) => {
              const nextRun = computeNextRun(data.cron as string)
              db.prepare('UPDATE paws SET next_run = ? WHERE id = ?').run(nextRun, pawId)
            }).catch(() => {})
          }
          logger.info({ pawId }, 'Paw updated via dashboard')
        }).catch(() => {})
      }).catch(() => {})
    } catch (err) {
      logger.error({ err, pawId }, 'Failed to update paw from dashboard')
    }
    return
  }

  if (msg.type === 'paw-deleted') {
    const pawId = msg.pawId as string | undefined
    if (!pawId) return
    try {
      import('./paws/index.js').then(({ deletePaw }) => {
        deletePaw(pawId)
        logger.info({ pawId }, 'Paw deleted via dashboard')
      }).catch((err) => {
        logger.error({ err, pawId }, 'Failed to delete paw from dashboard')
      })
    } catch (err) {
      logger.error({ err, pawId }, 'Failed to delete paw from dashboard')
    }
    return
  }

  if (msg.type === 'run-paw') {
    const pawId = msg.pawId as string | undefined
    if (!pawId) return
    logger.info({ pawId }, 'Run-paw trigger received from dashboard')
    if (!dashboardSendFn) {
      logger.warn('Run-paw received but sendFn not wired yet')
      return
    }
    const sendFn = dashboardSendFn
    Promise.all([
      import('./paws/index.js'),
      import('./souls.js'),
    ]).then(([{ triggerPaw, getPaw }, { getSoul, buildAgentPrompt }]) => {
      const paw = getPaw(pawId)
      const agentRunner = async (prompt: string): Promise<{ text: string | null }> => {
        const agentId = paw?.agent_id
        const projectId = paw?.project_id ?? 'default'
        const soul = agentId ? getSoul(agentId) : undefined
        let fullPrompt = prompt
        if (soul) {
          fullPrompt = `${buildAgentPrompt(soul, projectId)}\n\n---\n\n${prompt}`
        }
        const { text } = await runAgent(fullPrompt, undefined, undefined, undefined, undefined, {
          projectId,
          source: agentId ?? 'paw',
        }, {
          projectId,
          agentId: agentId ?? 'paw',
        })
        return { text }
      }
      triggerPaw(pawId, agentRunner, sendFn).catch((err) => {
        logger.error({ err, pawId }, 'Run-paw execution failed')
      })
    }).catch((err) => {
      logger.error({ err }, 'Failed to import paws for run-paw')
    })
    return
  }

  if (msg.type === 'paw-approve') {
    const pawId = msg.pawId as string | undefined
    const approved = msg.approved as boolean | undefined
    if (!pawId || typeof approved !== 'boolean') return
    logger.info({ pawId, approved }, 'Paw approval received from dashboard')
    if (!dashboardSendFn) {
      logger.warn('Paw approval received but sendFn not wired yet')
      return
    }
    const sendFn = dashboardSendFn
    import('./paws/index.js').then(({ processPawApproval }) => {
      processPawApproval(pawId, approved, sendFn).catch((err) => {
        logger.error({ err, pawId }, 'Paw approval execution failed')
      })
    }).catch((err) => {
      logger.error({ err }, 'Failed to import paws for paw-approve')
    })
    return
  }

  // Handle messages from the server (e.g., inter-agent messages to execute)
  if (msg.type === 'new_message') {
    logger.info({ message: msg }, 'Received inter-agent message from dashboard')
    // Future: route to the appropriate agent for execution
  }

  // Handle test run requests relayed from the dashboard
  if (msg.type === 'run-tests') {
    logger.info('Test run trigger received from dashboard')
    runTestsLocally()
    return
  }

  // Handle security scan triggers from the dashboard
  if (msg.type === 'security-trigger') {
    const scope = msg.scope as string | undefined
    if (!dashboardSendFn) {
      logger.warn('Security trigger received but sendFn not wired yet')
      return
    }
    const chatId = ALLOWED_CHAT_ID || ''
    if (!chatId) {
      logger.warn('Security trigger received but no ALLOWED_CHAT_ID configured')
      return
    }

    logger.info({ scope }, 'Security trigger received from dashboard')

    if (scope === 'daily' || scope === 'weekly') {
      executeSecurityScan(scope, 'manual', chatId, dashboardSendFn).catch((err) => {
        logger.error({ err }, 'Dashboard-triggered security scan failed')
      })
    } else if (scope) {
      // Treat as a single scanner ID
      executeSingleScan(scope, chatId, dashboardSendFn).catch((err) => {
        logger.error({ err, scannerId: scope }, 'Dashboard-triggered single scan failed')
      })
    }
  }

  // Handle action item mutations pushed from the server (dashboard-created items)
  // These keep the Mac's local SQLite in sync so the next snapshot sync doesn't clobber dashboard changes.

  if (msg.type === 'action_item_create') {
    const item = msg.item as ActionItem | undefined
    if (!item?.id || !item?.project_id) {
      logger.warn({ msg }, 'action_item_create: missing item data')
      return
    }
    try {
      const existing = getActionItem(item.id)
      if (!existing) {
        insertActionItem(item)
        logger.info({ itemId: item.id, projectId: item.project_id }, 'Action item created from dashboard')
      }
    } catch (err) {
      logger.error({ err, itemId: item.id }, 'Failed to persist action_item_create from dashboard')
    }
    return
  }

  if (msg.type === 'action_item_transition') {
    const itemId = msg.item_id as string | undefined
    const to = msg.to as string | undefined
    const actor = (msg.actor as string) || 'system'
    const reason = msg.reason as string | undefined
    const ts = (msg.ts as number) || Date.now()
    if (!itemId || !to) {
      logger.warn({ msg }, 'action_item_transition: missing item_id or to')
      return
    }
    try {
      const existing = getActionItem(itemId)
      if (existing) {
        const fields: Partial<ActionItem> = { status: to as ActionItem['status'] }
        if (to === 'completed') fields.completed_at = ts
        if (to === 'archived') fields.archived_at = ts
        updateActionItemFields(itemId, fields)
        insertActionItemEvent({ id: randomUUID(), item_id: itemId, actor, event_type: 'status_changed', old_value: existing.status, new_value: to, created_at: ts })
        if (reason) {
          insertActionItemComment({ id: randomUUID(), item_id: itemId, author: actor, body: reason, created_at: ts })
        }
        logger.info({ itemId, to }, 'Action item transitioned from dashboard')
      }
    } catch (err) {
      logger.error({ err, itemId }, 'Failed to persist action_item_transition from dashboard')
    }
    return
  }

  if (msg.type === 'upgrade') {
    // Trust: upgrade messages only arrive via the bot-server WS channel,
    // which is protected by WS_SECRET HMAC at registration time.
    logger.info('Upgrade command received from dashboard - spawning upgrade.sh')
    // Use import.meta.url so path resolution is reliable under launchd (cwd may vary).
    const scriptPath = fileURLToPath(new URL('../scripts/upgrade.sh', import.meta.url))
    const child = spawn('bash', [scriptPath], { detached: true, stdio: 'ignore' })
    child.on('error', (err) => {
      logger.error({ err, scriptPath }, 'upgrade.sh spawn failed')
    })
    child.unref()
    return
  }

  if (msg.type === 'mac_action_item_patch') {
    const itemId = msg.item_id as string | undefined
    const fields = msg.fields as Partial<ActionItem> | undefined
    if (!itemId || !fields || Object.keys(fields).length === 0) {
      logger.warn({ msg }, 'action_item_update: missing item_id or fields')
      return
    }
    try {
      updateActionItemFields(itemId, fields)
      logger.info({ itemId, fields: Object.keys(fields) }, 'Action item fields updated from dashboard')
    } catch (err) {
      logger.error({ err, itemId }, 'Failed to persist action_item_update from dashboard')
    }
    return
  }

  if (msg.type === 'action_item_comment') {
    const itemId = msg.item_id as string | undefined
    const commentId = (msg.comment_id as string) || randomUUID()
    const author = (msg.author as string) || 'human'
    const body = msg.body as string | undefined
    const createdAt = (msg.created_at as number) || Date.now()
    if (!itemId || !body) {
      logger.warn({ msg }, 'action_item_comment: missing item_id or body')
      return
    }
    try {
      insertActionItemComment({ id: commentId, item_id: itemId, author, body, created_at: createdAt })
      logger.info({ itemId, commentId }, 'Action item comment added from dashboard')
    } catch (err) {
      logger.error({ err, itemId }, 'Failed to persist action_item_comment from dashboard')
    }
    return
  }

  if (msg.type === 'action_item_delete') {
    const itemId = msg.item_id as string | undefined
    if (!itemId) {
      logger.warn({ msg }, 'action_item_delete: missing item_id')
      return
    }
    try {
      const deleted = deleteActionItem(itemId)
      if (deleted) {
        logger.info({ itemId }, 'Action item permanently deleted from dashboard')
      }
    } catch (err) {
      logger.error({ err, itemId }, 'Failed to delete action item from dashboard')
    }
    return
  }

  // Handle action plan chat agent dispatch (runs runAgent on the Mac, result goes back via WS)
  if (msg.type === 'run_action_item_chat') {
    const itemId = msg.item_id as string | undefined
    const projectId = msg.project_id as string | undefined
    const prompt = msg.prompt as string | undefined
    const agentJobId = msg.agent_job_id as string | undefined
    if (!itemId || !prompt) {
      logger.warn({ msg }, 'run_action_item_chat: missing item_id or prompt')
      return
    }
    // Extended timeout for interactive chat -- default 120s is too short for complex agent tasks
    const runtimeCtx = { projectId, executionOverride: { timeoutMs: 5 * 60 * 1000 } }
    runAgent(prompt, undefined, undefined, true, undefined, projectId ? { projectId, source: 'action-plan-chat' } : undefined, runtimeCtx).then((result) => {
      const agentText = result?.text ?? 'Agent completed with no output.'
      send({
        type: 'action_item_chat_result',
        item_id: itemId,
        project_id: projectId,
        agent_job_id: agentJobId,
        agent_text: agentText,
      })
      // REST fallback -- persists result even if WS dropped during the agent run
      fetch(`${DASHBOARD_BASE_URL}/api/v1/action-items/${itemId}/chat/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(BOT_API_TOKEN ? { 'x-dashboard-token': BOT_API_TOKEN } : {}) },
        body: JSON.stringify({ item_id: itemId, project_id: projectId, agent_job_id: agentJobId, agent_text: agentText }),
      }).catch(() => { /* silent fallback */ })
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error({ err, itemId }, 'run_action_item_chat: runAgent failed')
      send({
        type: 'action_item_chat_result',
        item_id: itemId,
        project_id: projectId,
        agent_job_id: agentJobId,
        agent_text: `Agent run failed: ${errMsg}`,
        is_error: true,
      })
    })
    return
  }

  if (msg.type === 'run_research_chat') {
    const itemId = msg.item_id as string | undefined
    const projectId = msg.project_id as string | undefined
    const prompt = msg.prompt as string | undefined
    const agentJobId = msg.agent_job_id as string | undefined
    if (!itemId || !prompt) {
      logger.warn({ msg }, 'run_research_chat: missing item_id or prompt')
      return
    }
    const runtimeCtx = { projectId, executionOverride: { timeoutMs: 5 * 60 * 1000 } }
    runAgent(prompt, undefined, undefined, true, undefined, projectId ? { projectId, source: 'research-chat' } : undefined, runtimeCtx).then((result) => {
      const agentText = result?.text ?? 'Scout completed with no output.'
      send({
        type: 'research_chat_result',
        item_id: itemId,
        project_id: projectId,
        agent_job_id: agentJobId,
        agent_text: agentText,
      })
      fetch(`${DASHBOARD_BASE_URL}/api/v1/research/${itemId}/chat/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(BOT_API_TOKEN ? { 'x-dashboard-token': BOT_API_TOKEN } : {}) },
        body: JSON.stringify({ item_id: itemId, project_id: projectId, agent_job_id: agentJobId, agent_text: agentText }),
      }).catch(() => {})
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error({ err, itemId }, 'run_research_chat: runAgent failed')
      fetch(`${DASHBOARD_BASE_URL}/api/v1/research/${itemId}/chat/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(BOT_API_TOKEN ? { 'x-dashboard-token': BOT_API_TOKEN } : {}) },
        body: JSON.stringify({ item_id: itemId, project_id: projectId, agent_job_id: agentJobId, agent_text: `Scout hit an error: ${errMsg}` }),
      }).catch(() => {})
    })
    return
  }

  if (msg.type === 'run_research_investigate') {
    const researchItemId = msg.research_item_id as string | undefined
    const projectId = msg.project_id as string | undefined
    const prompt = msg.prompt as string | undefined
    if (!researchItemId || !prompt) {
      logger.warn({ msg }, 'run_research_investigate: missing research_item_id or prompt')
      return
    }
    const runtimeCtx = { projectId, executionOverride: { timeoutMs: 10 * 60 * 1000 } }
    runAgent(prompt, undefined, undefined, true, undefined, projectId ? { projectId, source: 'research-investigate' } : undefined, runtimeCtx).then((result) => {
      const agentText = result?.text ?? 'Investigation returned no findings.'
      fetch(`${DASHBOARD_BASE_URL}/api/v1/research/${researchItemId}/investigate/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(BOT_API_TOKEN ? { 'x-dashboard-token': BOT_API_TOKEN } : {}) },
        body: JSON.stringify({ project_id: projectId, agent_text: agentText }),
      }).catch((err) => {
        logger.error({ err, researchItemId }, 'run_research_investigate: failed to POST result')
      })
    }).catch((err) => {
      logger.error({ err, researchItemId }, 'run_research_investigate: runAgent failed')
    })
    return
  }

  if (msg.type === 'run_research_draft') {
    const actionItemId = msg.action_item_id as string | undefined
    const researchItemId = msg.research_item_id as string | undefined
    const projectId = msg.project_id as string | undefined
    const format = msg.format as string | undefined
    const prompt = msg.prompt as string | undefined
    if (!actionItemId || !prompt) {
      logger.warn({ msg }, 'run_research_draft: missing action_item_id or prompt')
      return
    }
    const runtimeCtx = { projectId, executionOverride: { timeoutMs: 10 * 60 * 1000 } }
    runAgent(prompt, undefined, undefined, true, undefined, projectId ? { projectId, source: 'research-draft' } : undefined, runtimeCtx).then((result) => {
      const draftText = result?.text ?? 'Producer returned no draft.'
      fetch(`${DASHBOARD_BASE_URL}/api/v1/action-items/${actionItemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(BOT_API_TOKEN ? { 'x-dashboard-token': BOT_API_TOKEN } : {}) },
        body: JSON.stringify({ description: draftText, status: 'in_progress' }),
      }).then(() => {
        send({
          type: 'research_draft_ready',
          research_item_id: researchItemId,
          action_item: { id: actionItemId, status: 'in_progress', format },
        })
      }).catch((err) => {
        logger.error({ err, actionItemId }, 'run_research_draft: failed to PATCH action item')
      })
    }).catch((err) => {
      logger.error({ err, actionItemId }, 'run_research_draft: runAgent failed')
      fetch(`${DASHBOARD_BASE_URL}/api/v1/action-items/${actionItemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...(BOT_API_TOKEN ? { 'x-dashboard-token': BOT_API_TOKEN } : {}) },
        body: JSON.stringify({ description: `Producer failed: ${err instanceof Error ? err.message : String(err)}`, status: 'blocked' }),
      }).catch(() => {})
    })
    return
  }

  // Handle newsletter edition queries from the dashboard
  if (msg.type === 'get-newsletter-editions') {
    try {
      import('./newsletter/dedup.js').then(({ getRecentEditions }) => {
        const editions = getRecentEditions(20)
        send({ type: 'newsletter-editions', data: editions })
      }).catch((err) => {
        logger.error({ err }, 'Failed to fetch newsletter editions')
      })
    } catch (err) {
      logger.error({ err }, 'Failed to fetch newsletter editions')
    }
  }
}

export function disconnectDashboard(): void {
  cleanup()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.close()
    ws = null
  }
  connected = false
}

export function isDashboardConnected(): boolean {
  return connected
}

// ---------------------------------------------------------------------------
// Public API — call these from bot.ts, scheduler.ts, etc.
// ---------------------------------------------------------------------------

/**
 * Report an agent's status change to the dashboard
 */
/**
 * Sync all scheduled tasks to the dashboard server.
 * Called on connect and after any task changes (create, pause, resume, run).
 */
export function reportScheduledTasks(tasks: unknown[], projectId: string = 'default'): void {
  send({ type: 'tasks-sync', tasks, project_id: projectId })
}

export function reportActionPlanSnapshot(projectId: string): void {
  import('./db.js').then(({ listActionItems, listActionItemComments, listActionItemEvents }) => {
    const items = listActionItems({ projectId, includeArchived: true })
    const comments = items.flatMap(item => listActionItemComments(item.id))
    const events = items.flatMap(item => listActionItemEvents(item.id))

    fetch(`${DASHBOARD_BASE_URL}/api/v1/action-items/sync`, {
      method: 'POST',
      headers: dashboardApiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ project_id: projectId, items, comments, events }),
    }).catch(() => { /* silent fallback */ })
  }).catch((err) => {
    logger.error({ err, projectId }, 'Failed to prepare action plan snapshot for dashboard sync')
  })
}

export function reportAgentStatus(
  agentId: string,
  status: 'online' | 'active' | 'idle' | 'sleeping' | 'error',
  task?: string,
  projectId?: string,
): void {
  send({ type: 'agent_status', agentId, status, task, project_id: projectId })

  // Also POST to REST API as fallback
  fetch(`${DASHBOARD_BASE_URL}/api/v1/agents/${agentId}`, {
    method: 'PATCH',
    headers: dashboardApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ status, current_task: task ?? null, project_id: projectId ?? null }),
  }).catch(() => { /* silent fallback */ })
}

/**
 * Add an item to the activity feed
 */
export function reportFeedItem(
  agentId: string,
  action: string,
  detail?: string,
  projectId?: string,
): void {
  send({ type: 'feed_item', data: { agent_id: agentId, action, detail, project_id: projectId } })

  fetch(`${DASHBOARD_BASE_URL}/api/v1/feed`, {
    method: 'POST',
    headers: dashboardApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ agent_id: agentId, action, detail, project_id: projectId ?? null }),
  }).catch(() => { /* silent fallback */ })
}

/**
 * Send an inter-agent message
 */
export function sendAgentMessage(
  from: string,
  to: string,
  content: string,
  type: 'task' | 'result' | 'info' | 'error' | 'handoff' = 'info',
): void {
  fetch(`${DASHBOARD_BASE_URL}/api/v1/messages`, {
    method: 'POST',
    headers: dashboardApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ from_agent: from, to_agent: to, content, type }),
  }).catch(() => { /* silent fallback */ })
}

/**
 * Record a metric (costs, token usage, etc.)
 */
export function reportMetric(
  category: string,
  key: string,
  value: number,
  metadata?: string,
): void {
  fetch(`${DASHBOARD_BASE_URL}/api/v1/metrics`, {
    method: 'POST',
    headers: dashboardApiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ category, key, value, metadata }),
  }).catch(() => { /* silent fallback */ })
}

/**
 * Report agent heartbeat
 */
export function reportHeartbeat(agentId: string): void {
  fetch(`${DASHBOARD_BASE_URL}/api/v1/agents/${agentId}/heartbeat`, {
    method: 'POST',
    headers: dashboardApiHeaders(),
  }).catch(() => { /* silent fallback */ })
}

/**
 * Push bot health snapshot to the dashboard server over WS
 */
export function reportBotHealth(snapshot: Record<string, unknown>): void {
  send({ type: 'bot-health', data: snapshot })
}

export function reportPlugins(plugins: unknown[]): void {
  send({ type: 'plugins-sync', plugins })
}

export function reportChannelLog(entry: Record<string, unknown>): void {
  send({ type: 'channel_log', data: entry })
}

export function reportPawsState(projectId?: string): void {
  try {
    import('./paws/index.js').then(({ listPaws, getLatestCycle }) => {
      const paws = listPaws(projectId)
      // Include latest cycle for each paw so the dashboard can show findings/approval context
      const cycles = paws
        .map(p => {
          const c = getLatestCycle(p.id)
          return c ? {
            id: c.id,
            paw_id: c.paw_id,
            started_at: c.started_at,
            phase: c.phase,
            state: typeof c.state === 'string' ? c.state : JSON.stringify(c.state),
            findings: typeof c.findings === 'string' ? c.findings : JSON.stringify(c.findings),
            actions_taken: typeof c.actions_taken === 'string' ? c.actions_taken : JSON.stringify(c.actions_taken),
            report: c.report,
            completed_at: c.completed_at,
            error: c.error,
          } : null
        })
        .filter(Boolean)
      fetch(`${DASHBOARD_BASE_URL}/api/v1/internal/paws-sync`, {
        method: 'POST',
        headers: dashboardApiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ paws, cycles, project_id: projectId }),
      }).catch(() => {})
    }).catch(() => {})
  } catch {
    // Silently fail -- dashboard sync is best-effort
  }
}

// ---------------------------------------------------------------------------
// Local test runner -- spawns vitest on the Mac and streams results to dashboard
// ---------------------------------------------------------------------------

function sendTestUpdate(data: Record<string, unknown>): void {
  send({ type: 'test-update', data })
}

function runTestsLocally(): void {
  const projectRoot = '.'
  const nodePath = '/opt/homebrew/bin/node'
  const vitestBin = `${projectRoot}/node_modules/.bin/vitest`

  sendTestUpdate({ status: 'running', message: 'Running tests on Mac...' })

  const child = spawn(nodePath, [vitestBin, 'run', '--reporter=json'], {
    cwd: projectRoot,
    env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}`, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })

  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
    const lines = chunk.toString().split('\n').filter((l: string) => l.trim())
    for (const line of lines) {
      if (line.includes('\u2713') || line.includes('\u00d7') || line.includes('PASS') || line.includes('FAIL')) {
        sendTestUpdate({ status: 'progress', line })
      }
    }
  })

  child.on('close', (code: number | null) => {
    let results: Record<string, unknown> | null = null
    try {
      results = JSON.parse(stdout)
    } catch {
      results = { raw: true, stdout: stdout.slice(-5000), stderr: stderr.slice(-5000) }
    }

    sendTestUpdate({
      status: code === 0 ? 'passed' : 'failed',
      exitCode: code,
      results,
      completedAt: Date.now(),
    })

    logger.info({ exitCode: code }, 'Local test run completed')
  })

  child.on('error', (err: Error) => {
    sendTestUpdate({ status: 'error', message: err.message })
    logger.error({ err }, 'Local test runner spawn failed')
  })
}
