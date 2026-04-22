import cronParser from 'cron-parser'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getDueTasks, updateTaskAfterRun, listTasks, getProject, clearStaleRunningTasks, archiveStaleActionItems, purgeArchivedActionItems, getDb, getKvSetting, setKvSetting, getBacklogTasks } from './db.js'
import { reapStalePawCycles, getBacklogPaws, updatePawNextRun } from './paws/db.js'
import { runSkillSynthesis } from './learning/synthesizer.js'
import { reportAgentStatus, reportFeedItem, reportScheduledTasks, reportPawsState } from './dashboard.js'
import { getAllSouls, getSoul, buildAgentPrompt } from './souls.js'
import { executeSecurityScan } from './security/index.js'
import { generateAndSendNewsletter } from './newsletter/index.js'
import { logger } from './logger.js'
import { BOT_API_TOKEN, DASHBOARD_URL } from './config.js'
import { startRequest, recordError } from './telemetry.js'
import { fireTaskCompleted } from './webhooks/index.js'
import { extractAndLogFindings } from './research.js'
import { parseActionItemsFromAgentOutput, ingestParsedItems } from './action-items.js'
import { buildExampleCompanyTaskContext } from './projects/example-company/task-context.js'
import { buildDefaultTaskContext } from './projects/default/task-context.js'
import { getDuePaws, triggerPaw } from './paws/index.js'
import { publishDueSocialPosts } from './social/index.js'
import { checkAndUpgrade } from './system-update.js'

const execFileAsync = promisify(execFile)

// Prevents running auto-upgrade more than once per calendar day.
// Persisted via kv_settings so launchd respawns (or any restart within the
// same day) do not re-trigger the upgrade. Key: scheduler.lastAutoUpgradeDate.
const LAST_AUTO_UPGRADE_DATE_KEY = 'scheduler.lastAutoUpgradeDate'

function getLastAutoUpgradeDate(): string | null {
  return getKvSetting(LAST_AUTO_UPGRADE_DATE_KEY)
}

function setLastAutoUpgradeDate(value: string): void {
  setKvSetting(LAST_AUTO_UPGRADE_DATE_KEY, value)
}

function sweepArchivedCredentials(): void {
  try {
    const db = getDb()
    const retentionDays = Number(process.env.INTEGRATION_CREDENTIAL_RETENTION_DAYS ?? '30')
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const result = db.prepare(
      'DELETE FROM project_credentials WHERE archived_at IS NOT NULL AND archived_at < ?'
    ).run(cutoff)
    if (result.changes > 0) {
      logger.info({ deleted: result.changes, retentionDays }, 'Archived credentials swept')
    }
  } catch (err) {
    logger.warn({ err }, 'Credential sweep failed')
  }
}

// ── Types ──────────────────────────────────────────────────────────────

type Sender = (chatId: string, text: string) => Promise<void>

interface ScheduledTask {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  created_at: number
  project_id: string
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Resolve a project_id to a display label for Telegram messages */
function projectLabel(projectId: string): string {
  if (!projectId) return ''
  const proj = getProject(projectId)
  return proj?.display_name ?? projectId
}

/** Wrap a message with the project prefix when applicable */
function withProject(projectId: string, msg: string): string {
  const label = projectLabel(projectId)
  if (!label) return msg
  return `[${label}] ${msg}`
}

function actionPlanUrl(): string {
  return `${DASHBOARD_URL.replace(/\/$/, '')}/#action-plan`
}

function summarizeActionItemNotification(agentId: string, result: string): string | null {
  const items = parseActionItemsFromAgentOutput(result)
  if (items.length === 0) return null
  const label = items.length === 1 ? 'item' : 'items'
  return `${agentId} added ${items.length} ${label} to Action Plan. Open: ${actionPlanUrl()}`
}

function summarizeIssueNotification(agentId: string, preview: string, emptyReason?: string): string {
  const taskLabel = preview.trim() || 'scheduled task'
  const detail = emptyReason ?? 'Agent returned no text.'
  return `Issue: ${agentId} returned no usable result for ${taskLabel}. ${detail}`
}

async function augmentTaskPrompt(
  task: ScheduledTask,
  cleanPrompt: string,
): Promise<string> {
  let context: string | null = null

  try {
    if (task.project_id === 'example-company') {
      context = await buildExampleCompanyTaskContext(task.id)
    } else if (task.project_id === 'default') {
      context = await buildDefaultTaskContext(task.id)
    }
  } catch (err) {
    // Auth/token errors during context building should not kill the task.
    // Run the task without enriched context and note the issue.
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.warn({ taskId: task.id, projectId: task.project_id, err: errMsg }, 'Context augmentation failed, running task without enriched context')
    return `${cleanPrompt}\n\nNote: Pre-fetched context unavailable (${errMsg}). Proceed with the task using available tools.`
  }

  if (!context) return cleanPrompt

  return `${cleanPrompt}\n\n${context}\n\nUse the provided structured context first. Only use web research for public, non-Google follow-up work.`
}

// ── Task sync ─────────────────────────────────────────────────────────

/** Push all scheduled tasks to the dashboard server */
export function syncTasksToDashboard(): void {
  try {
    const tasks = listTasks()
    // Group tasks by project_id and sync each group separately
    // so the dashboard server correctly scopes them
    const byProject = new Map<string, typeof tasks>()
    for (const t of tasks) {
      const pid = t.project_id || 'default'
      if (!byProject.has(pid)) byProject.set(pid, [])
      byProject.get(pid)!.push(t)
    }
    for (const [pid, projectTasks] of byProject) {
      reportScheduledTasks(projectTasks, pid)
    }
  } catch (err) {
    logger.error({ err }, 'Failed to sync tasks to dashboard')
  }
}

// ── Constants ──────────────────────────────────────────────────────────

/**
 * Prepended to every agent prompt in scheduled and manual task runs.
 * Suppresses git-awareness behavior so agents don't waste time running
 * git status or asking about uncommitted changes.
 */
const SCHEDULED_TASK_PREAMBLE = 'SCHEDULED TASK: You are running as an automated scheduled agent. Do NOT run git status, git diff, or ask about uncommitted changes. Do NOT commit or push code unless explicitly instructed in the task. Focus only on the task below.\n\n---\n\n'

// ── Internal state ─────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null
let credentialSweepHandle: ReturnType<typeof setInterval> | null = null
let storedSendApproval: ((chatId: string, text: string, pawId: string) => Promise<void>) | undefined
let storedPawSend: import('./paws/types.js').PawSender | undefined
const runningTasks = new Set<string>()  // per-task lock to prevent overlap
const runningPaws = new Set<string>()   // per-paw lock to prevent concurrent cycles

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS   = 30 * 24 * 60 * 60 * 1000

function kvGet(key: string): number {
  try {
    const row = getDb().prepare('SELECT value FROM kv_settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? Number(row.value) : 0
  } catch {
    return 0
  }
}

function kvSet(key: string, value: number): void {
  try {
    getDb().prepare('INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)').run(key, String(value))
  } catch (err) {
    logger.warn({ err }, `[scheduler] failed to persist kv_settings key=${key}`)
  }
}

let lastAutoArchiveRun = 0
let lastAutoPurgeRun   = 0

function loadArchiveState(): void {
  lastAutoArchiveRun = kvGet('scheduler.last_auto_archive_run')
  lastAutoPurgeRun   = kvGet('scheduler.last_auto_purge_run')
}

function maybeRunAutoArchive(): void {
  const now = Date.now()
  // Run at most once every 12 hours
  if (now - lastAutoArchiveRun < 12 * 60 * 60 * 1000) return
  // Only run between 03:00 and 04:00 local time
  const hour = new Date(now).getHours()
  if (hour !== 3) return
  const cutoff = now - FOURTEEN_DAYS_MS
  const archived = archiveStaleActionItems(cutoff)
  lastAutoArchiveRun = now
  kvSet('scheduler.last_auto_archive_run', now)
  if (archived > 0) {
    logger.info(`[action-items] auto-archived ${archived} items`)
  }
}

function maybeRunAutoPurge(): void {
  const now = Date.now()
  // Run at most once every 12 hours
  if (now - lastAutoPurgeRun < 12 * 60 * 60 * 1000) return
  // Only run between 04:00 and 05:00 local time
  const hour = new Date(now).getHours()
  if (hour !== 4) return
  const cutoff = now - THIRTY_DAYS_MS
  const purged = purgeArchivedActionItems(cutoff)
  lastAutoPurgeRun = now
  kvSet('scheduler.last_auto_purge_run', now)
  if (purged > 0) {
    logger.info(`[action-items] auto-purged ${purged} permanently deleted items`)
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Start the scheduler loop — checks for due tasks every 60 seconds.
 */
export function initScheduler(
  send: Sender,
  sendApproval?: (chatId: string, text: string, pawId: string) => Promise<void>,
  pawSend?: import('./paws/types.js').PawSender,
): void {
  if (intervalHandle) {
    logger.warn('Scheduler already running — skipping duplicate init')
    return
  }

  storedSendApproval = sendApproval
  storedPawSend = pawSend

  // Clean up tasks stuck in 'running...' from a previous crash/restart
  const cleared = clearStaleRunningTasks()
  if (cleared > 0) {
    logger.info({ cleared }, 'Reset stale running tasks from previous session')
    syncTasksToDashboard()
  }

  // Reap orphaned Paw cycles left in an in-progress phase after a crash, and
  // unstick Paws frozen in `waiting_approval` whose cycle was reaped. Prevents
  // the "Paw goes silent forever" failure mode and the "next cycle picks up
  // malformed previous findings" poisoning.
  try {
    const reaped = reapStalePawCycles(getDb())
    if (reaped.cyclesReaped > 0 || reaped.pawsUnstuck > 0) {
      logger.info(reaped, 'Reaped stale Paw cycles + unstuck approval Paws from previous session')
    }
  } catch (err) {
    logger.warn({ err }, 'reapStalePawCycles failed (non-fatal)')
  }

  // Skip-missed for backlog protection. If the bot was offline for hours (or
  // the Mac was asleep overnight), a naive scheduler fires ALL missed tasks
  // + Paws at once when it resumes — that's a "thundering herd" of LLM calls
  // hitting cost caps and rate limits simultaneously. Instead, advance each
  // backlogged item's next_run to its next future occurrence and log the
  // skip. Tunable via SCHEDULER_MAX_BACKLOG_MS (default 15 minutes).
  try {
    const backlogWindowMs = Number(process.env.SCHEDULER_MAX_BACKLOG_MS ?? '') || 15 * 60 * 1000
    const backlogTasks = getBacklogTasks(backlogWindowMs)
    for (const task of backlogTasks) {
      const nextRun = task.schedule ? computeNextRun(task.schedule) : Date.now() + backlogWindowMs
      updateTaskAfterRun(task.id, 'skipped (backlog)', nextRun)
    }
    const backlogPaws = getBacklogPaws(getDb(), backlogWindowMs)
    for (const paw of backlogPaws) {
      try {
        const nextRun = computeNextRun(paw.cron)
        updatePawNextRun(getDb(), paw.id, nextRun)
      } catch {
        // Unparseable cron — leave alone; operator will notice it's not firing
      }
    }
    if (backlogTasks.length > 0 || backlogPaws.length > 0) {
      logger.warn({
        tasksSkipped: backlogTasks.length,
        pawsSkipped: backlogPaws.length,
        backlogWindowMs,
      }, 'Skipped backlog from previous outage — advanced next_run to next future occurrence')
    }
  } catch (err) {
    logger.warn({ err }, 'backlog skip-missed failed (non-fatal)')
  }

  // Restore archive/purge gate timestamps so restarts don't reset the 12-hour guard
  loadArchiveState()

  reportPawsState()

  logger.info('Scheduler started — polling every 60 s')
  intervalHandle = setInterval(() => {
    runDueTasks(send).catch((err) => {
      logger.error({ err }, 'Scheduler tick failed')
      recordError('scheduler', 'error', err instanceof Error ? err.message : String(err), err instanceof Error ? err.stack : undefined, { context: 'tick' })
    })
  }, 60_000)

  // Run once immediately on startup
  runDueTasks(send).catch((err) => {
    logger.error({ err }, 'Scheduler initial run failed')
    recordError('scheduler', 'error', err instanceof Error ? err.message : String(err), err instanceof Error ? err.stack : undefined, { context: 'tick' })
  })

  // Sweep archived credentials hourly + run once on startup
  sweepArchivedCredentials()
  credentialSweepHandle = setInterval(sweepArchivedCredentials, 60 * 60 * 1000)
}

/**
 * Stop the scheduler loop. Clears both the main tick interval and the
 * hourly credential sweep interval so the process can exit cleanly.
 * Safe to call multiple times.
 */
export function stopScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  if (credentialSweepHandle) {
    clearInterval(credentialSweepHandle)
    credentialSweepHandle = null
  }
}

/**
 * Find and execute all tasks whose next_run has passed.
 * Tasks run concurrently via Promise.allSettled; per-task deduplication is
 * handled by the runningTasks Set to prevent overlap with manual triggers.
 */
export async function runDueTasks(send: Sender): Promise<void> {
  // T3-C: skip the entire tick when kill switch is tripped
  const { checkKillSwitch } = await import('./cost/kill-switch-client.js')
  const sw = await checkKillSwitch()
  if (sw) {
    logger.warn({ reason: sw.reason }, 'scheduler tick skipped - kill switch active')
    return
  }

  // Nightly auto-upgrade during the 2am hour.
  // We check the full hour (not a single minute) so a lagged scheduler tick doesn't silently skip.
  // The date guard prevents multiple runs on the same calendar day.
  const upgradeNow = new Date()
  if (upgradeNow.getHours() === 2) {
    const todayKey = upgradeNow.toDateString()
    if (getLastAutoUpgradeDate() !== todayKey) {
      setLastAutoUpgradeDate(todayKey)
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'])
        const gitHash = stdout.trim()
        checkAndUpgrade(gitHash)
          .then(result => {
            if (result.upgraded) {
              logger.info({ behind: result.behind }, 'Nightly auto-upgrade initiated')
            }
          })
          .catch(err => logger.error({ err }, 'Nightly checkAndUpgrade failed'))
      } catch (err) {
        logger.warn({ err }, 'Failed to read git hash for nightly upgrade check')
      }
    }
  }
  maybeRunAutoArchive()
  maybeRunAutoPurge()

  // Also run the reaper here (not just at startup) so an approval Paw whose
  // user never responds gets unstuck within one tick of hitting its configured
  // approval_timeout_sec -- without requiring a bot restart.
  try {
    const reaped = reapStalePawCycles(getDb())
    if (reaped.cyclesReaped > 0 || reaped.pawsUnstuck > 0) {
      logger.info(reaped, 'Reaper unstuck Paws mid-tick (approval timeout or orphan cycle)')
    }
  } catch (err) {
    logger.warn({ err }, 'reapStalePawCycles mid-tick failed (non-fatal)')
  }

  await executeDueTasks(send)
}

async function executeDueTasks(send: Sender): Promise<void> {
  const tasks: ScheduledTask[] = getDueTasks()

  if (tasks.length > 0) {
    logger.info({ count: tasks.length }, 'Running due scheduled tasks')

    const taskPromises = tasks
      .filter((task) => {
        if (runningTasks.has(task.id)) {
          logger.info({ taskId: task.id }, 'Skipping due task — already running (manual trigger)')
          return false
        }
        return true
      })
      .map((task) => runSingleScheduledTask(task, send))

    await Promise.allSettled(taskPromises)
  }

  // ── Paws Mode: run due paws ──
  try {
    const duePaws = getDuePaws()
    if (duePaws.length > 0) {
      logger.info({ count: duePaws.length }, 'Running due paws')
      const pawPromises = duePaws
        .filter((paw) => {
          if (runningPaws.has(paw.id)) {
            logger.info({ pawId: paw.id }, 'Paw already running, skipping')
            return false
          }
          return true
        })
        .map(async (paw) => {
          runningPaws.add(paw.id)
          try {
            const { runAgent: importedRunAgent } = await import('./agent.js')
            const agentRunner = async (prompt: string): Promise<{ text: string | null; emptyReason?: string; resultSubtype?: string }> => {
              const soul = getSoul(paw.agent_id)
              let fullPrompt = prompt
              if (soul) {
                fullPrompt = `${buildAgentPrompt(soul, paw.project_id)}\n\n---\n\n${prompt}`
              }
              const { text, emptyReason, resultSubtype } = await importedRunAgent(fullPrompt, undefined, undefined, undefined, undefined, {
                projectId: paw.project_id,
                source: paw.agent_id,
              }, {
                projectId: paw.project_id,
                agentId: paw.agent_id,
              })
              return { text, emptyReason, resultSubtype }
            }
            await triggerPaw(paw.id, agentRunner, send, storedSendApproval, storedPawSend)
          } catch (err) {
            logger.error({ err, pawId: paw.id }, 'Paw cycle failed')
            await send(paw.config.chat_id, `Paw "${paw.name}" cycle failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {})
          } finally {
            runningPaws.delete(paw.id)
          }
        })
      await Promise.allSettled(pawPromises)
      reportPawsState()
    }
  } catch (err) {
    logger.error({ err }, 'Paws scheduler tick failed')
  }

  // ── Social posts: auto-publish anything whose scheduled_at has passed ──
  try {
    // TODO(future): replace with a per-project lookup in project_settings.
    // For now the only project using scheduled social posts is default.
    const socialChatId = '123456789'
    const socialRes = await publishDueSocialPosts(send, socialChatId)
    if (socialRes.attempted > 0) {
      logger.info(socialRes, 'Scheduler tick: social auto-publish')
    }
  } catch (err) {
    logger.error({ err }, 'Scheduler tick: social auto-publish failed')
  }

  // Sync updated task state to dashboard after all tasks run
  syncTasksToDashboard()
}

async function runSingleScheduledTask(task: ScheduledTask, send: Sender): Promise<void> {
  const wasRunning = runningTasks.has(task.id)
  runningTasks.add(task.id)
  if (wasRunning) return
  const preview = task.prompt.slice(0, 50)

  // Project-aware sender: prefixes messages with [Project Name] for multi-project visibility
  const psend: Sender = async (chatId, text) => send(chatId, withProject(task.project_id, text))

  // Pre-compute next_run so the catch block always has a valid value
  // (previously was initialized to 0, causing permanently stuck tasks
  // if a bypass branch threw after its await)
  const nextRun = computeNextRun(task.schedule)

  // Tracker is only set in the general LLM path (bypass paths return early before it's created)
  let tracker: ReturnType<typeof startRequest> | undefined

  try {
    // ── Security scan bypass: run deterministic code, no LLM ──
    if (task.id === 'security-daily-scan' || task.id === 'security-weekly-audit') {
      const scope = task.id === 'security-daily-scan' ? 'daily' as const : 'weekly' as const
      // Advance next_run IMMEDIATELY to prevent re-execution on crash/restart
      // nextRun already computed above
      updateTaskAfterRun(task.id, 'running...', nextRun)

      const agentId = mapTaskToAgent(task.id)
      reportAgentStatus(agentId, 'active', `Security ${scope} scan`)
      reportFeedItem(agentId, 'Security scan started', scope)

      const result = await executeSecurityScan(scope, 'scheduled', task.chat_id, psend)

      updateTaskAfterRun(task.id, result.slice(0, 2000), nextRun)
      reportAgentStatus(agentId, 'idle')
      reportFeedItem(agentId, 'Security scan completed', scope)
      fireTaskCompleted({ task_id: task.id, task_preview: `Security ${scope} scan`, result_preview: result.slice(0, 500), status: 'success' }, task.project_id || 'default')
      logger.info({ taskId: task.id, nextRun }, 'Security scan task completed')
      return
    }

    // ── Skill synthesis bypass: uses its own agent session ──
    if (task.id === 'learning-weekly-synthesis') {
      const agentId = 'builder'
      reportAgentStatus(agentId, 'active', 'Weekly skill synthesis')
      reportFeedItem(agentId, 'Skill synthesis started', 'weekly')

      const { runAgent } = await import('./agent.js')
      const agentRunner = async (prompt: string): Promise<string | null> => {
        const soul = getSoul('builder')
        let fullPrompt = prompt
        if (soul) {
          fullPrompt = `${buildAgentPrompt(soul)}\n\n---\n\n${prompt}`
        }
        const { text } = await runAgent(fullPrompt, undefined, undefined, undefined, undefined, undefined, {
          agentId: 'builder',
        })
        return text
      }

      const result = await runSkillSynthesis(agentRunner, psend, task.chat_id)

      // nextRun already computed above
      updateTaskAfterRun(task.id, result.slice(0, 2000), nextRun)
      reportAgentStatus(agentId, 'idle')
      reportFeedItem(agentId, 'Skill synthesis completed', 'weekly')
      logger.info({ taskId: task.id, nextRun }, 'Skill synthesis task completed')
      return
    }

    // ── Metrics collection bypass: deterministic HTTP call, no LLM ──
    if (task.id === 'metrics-daily-collection') {
      updateTaskAfterRun(task.id, 'running...', nextRun)
      const agentId = mapTaskToAgent(task.id)
      reportAgentStatus(agentId, 'active', 'Daily metrics collection', task.project_id)
      reportFeedItem(agentId, 'Metrics collection started', 'daily', task.project_id)

      const collectRes = await fetch(`${DASHBOARD_URL}/api/v1/metrics/collect`, {
        method: 'POST',
        headers: BOT_API_TOKEN ? { 'x-dashboard-token': BOT_API_TOKEN } : undefined,
      })
      const collectData = await collectRes.json() as { ok: boolean; summary?: string; error?: string }
      const result = collectData.ok ? (collectData.summary ?? 'Metrics collected') : `Failed: ${collectData.error}`

      updateTaskAfterRun(task.id, result.slice(0, 2000), nextRun)
      reportAgentStatus(agentId, 'idle', undefined, task.project_id)
      reportFeedItem(agentId, 'Metrics collected', result.slice(0, 200), task.project_id)
      fireTaskCompleted({ task_id: task.id, task_preview: 'Daily metrics collection', result_preview: result.slice(0, 500), status: collectData.ok ? 'success' : 'error' }, task.project_id || 'default')
      logger.info({ taskId: task.id, nextRun }, 'Metrics collection task completed')
      return
    }

    // ── Newsletter bypass: run deterministic code, no LLM ──
    if (task.id === 'newsletter-monday' || task.id === 'newsletter-thursday') {
      // Advance next_run IMMEDIATELY to prevent re-execution on crash/restart
      // nextRun already computed above
      updateTaskAfterRun(task.id, 'running...', nextRun)

      const agentId = 'scout'
      reportAgentStatus(agentId, 'active', 'Newsletter generation', task.project_id)
      reportFeedItem(agentId, 'Newsletter started', task.id, task.project_id)

      const result = await generateAndSendNewsletter(task.chat_id, psend)

      updateTaskAfterRun(task.id, result.slice(0, 2000), nextRun)
      reportAgentStatus(agentId, 'idle')
      logger.info({ taskId: task.id, nextRun }, 'Newsletter task completed')
      return
    }

    // Advance next_run IMMEDIATELY to prevent re-execution on crash/restart
    updateTaskAfterRun(task.id, 'running...', nextRun)

    // Check for [silent] prefix: agent handles its own output (e.g. via social-cli notify)
    const silent = task.prompt.startsWith('[silent]')
    const basePrompt = silent ? task.prompt.slice('[silent]'.length).trimStart() : task.prompt
    const cleanPrompt = await augmentTaskPrompt(task, basePrompt)

    // Resolve project context for agent lookup
    const taskProject = getProject(task.project_id)
    const taskProjectSlug = taskProject?.slug

    // Report to dashboard (no Telegram notification -- keep it quiet)
    const agentId = mapTaskToAgent(task.id, taskProjectSlug)
    reportAgentStatus(agentId, 'active', preview, task.project_id)
    reportFeedItem(agentId, 'Task started', preview, task.project_id)

    // Dynamically import agent to avoid circular deps
    const { runAgent } = await import('./agent.js')

    // Inject agent soul if available (project-aware lookup)
    let taskPrompt = cleanPrompt
    const soul = getSoul(agentId, taskProjectSlug)
    if (soul) {
      const agentPrompt = buildAgentPrompt(soul, task.project_id)
      taskPrompt = `${agentPrompt}\n\n---\n\n${cleanPrompt}`
    }

    // Prepend scheduled task preamble to suppress git-awareness behavior
    // (agents should not run git status or ask about uncommitted changes during scheduled runs)
    taskPrompt = `${SCHEDULED_TASK_PREAMBLE}${taskPrompt}`

    tracker = startRequest(
      task.chat_id,
      'scheduler',
      task.prompt.slice(0, 80),
      taskPrompt,
      task.project_id || 'default',
    )
    tracker.setAgentId(agentId)
    tracker.markAgentStarted()

    const agentRes = await runAgent(taskPrompt, undefined, undefined, undefined,
      (event) => tracker?.recordSdkEvent(event),
      {
        projectId: task.project_id || 'default',
        source: agentId,
      }, {
        projectId: task.project_id || 'default',
        projectSlug: taskProjectSlug,
        agentId,
      })
    const text = agentRes.text

    tracker.markAgentEnded()
    tracker.setExecutionMeta({
      requestedProvider: agentRes.requestedProvider,
      executedProvider: agentRes.executedProvider,
      providerFallbackApplied: agentRes.providerFallbackApplied,
    })
    if (agentRes.text) tracker.setResultText(agentRes.text)

    const result =
      text && text.trim().length > 0
        ? text
        : `Agent returned no text. ${agentRes.emptyReason ?? 'No diagnostic info available.'}\n\nTask: ${preview}\nAgent: ${agentId}\nWhat to do: check the bot logs (npm run logs) for the matching task ID, or rerun the task from the dashboard with Run Now.`

    // Extract and log any research findings
    extractAndLogFindings(result, agentId, task.project_id).catch((err) => {
      logger.warn({ err, taskId: task.id }, 'Research finding extraction failed')
    })

    // Persist any action items the agent proposed to the DB
    if (text && text.trim().length > 0 && task.project_id) {
      const parsedItems = parseActionItemsFromAgentOutput(result)
      if (parsedItems.length > 0) {
        ingestParsedItems(parsedItems, {
          project_id: task.project_id,
          source: agentId,
          proposed_by: agentId,
        })
      }
    }

    // Scheduled Telegram stays quiet by default.
    // Silent tasks handle their own output (e.g. social-cli sends drafts with buttons).
    if (!silent) {
      const notification = text && text.trim().length > 0
        ? summarizeActionItemNotification(agentId, result)
        : summarizeIssueNotification(agentId, preview, agentRes.emptyReason)
      if (notification) {
        await psend(task.chat_id, notification)
      }
    }

    // Persist result (next_run already advanced above)
    updateTaskAfterRun(task.id, result.slice(0, 2000), nextRun)

    reportAgentStatus(agentId, 'idle', undefined, task.project_id)
    // Store result preview (not prompt) so the dashboard briefing banner shows actual output
    reportFeedItem(agentId, 'Task completed', result.slice(0, 200), task.project_id)
    fireTaskCompleted({ task_id: task.id, task_preview: preview, result_preview: result.slice(0, 500), status: 'success' }, task.project_id || 'default')
    logger.info({ taskId: task.id, nextRun }, 'Scheduled task completed')
  } catch (err) {
    const errMsg =
      err instanceof Error ? err.message : String(err)

    recordError('scheduler', 'error', errMsg, err instanceof Error ? err.stack : undefined, { taskId: task.id })
    logger.error({ err, taskId: task.id }, 'Scheduled task failed')

    // Notify user of failure
    await psend(
      task.chat_id,
      `\u274C Scheduled task failed: ${preview}...\nError: ${errMsg.slice(0, 500)}`,
    ).catch(() => {
      // Don't let notification failure crash the loop
    })

    reportAgentStatus(mapTaskToAgent(task.id), 'error', errMsg.slice(0, 100), task.project_id)
    reportFeedItem(mapTaskToAgent(task.id), 'Task failed', errMsg.slice(0, 200), task.project_id)
    fireTaskCompleted({ task_id: task.id, task_preview: preview, result_preview: errMsg.slice(0, 500), status: 'error' }, task.project_id || 'default')

    // Persist error result (next_run already advanced above)
    updateTaskAfterRun(task.id, `ERROR: ${errMsg.slice(0, 1000)}`, nextRun)
  } finally {
    runningTasks.delete(task.id)
    if (tracker) {
      try {
        tracker.finalize()
      } catch (err) {
        logger.warn({ err }, 'Scheduler telemetry finalize failed (non-fatal)')
      }
      try {
        const row = tracker.toEventRow()
        fetch(`${DASHBOARD_URL}/api/v1/chat/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(BOT_API_TOKEN ? { 'x-dashboard-token': BOT_API_TOKEN } : {}),
          },
          body: JSON.stringify(row),
        }).catch((err: unknown) => {
          logger.warn({ err }, 'Scheduler telemetry sync failed (non-fatal)')
        })
      } catch (err) {
        logger.warn({ err }, 'Scheduler telemetry sync setup failed (non-fatal)')
      }
    }
  }
}

/**
 * Run a single task immediately (triggered from dashboard "Run Now" button).
 */
export async function runTaskNow(task: ScheduledTask, send: Sender): Promise<void> {
  // Kill-switch gate. The cron path checks this at the top of runDueTasks;
  // the manual "Run Now" path used to rely solely on runAgent's gate, which
  // leaves the deterministic bypasses (newsletter, security scan, metrics)
  // uncovered. A tripped kill switch must stop manual triggers too.
  try {
    const { checkKillSwitch } = await import('./cost/kill-switch-client.js')
    const sw = await checkKillSwitch()
    if (sw) {
      logger.warn({ taskId: task.id, reason: sw.reason }, 'Run Now blocked by kill switch')
      try { await send(task.chat_id, `Run Now blocked: kill switch active (${sw.reason}). Clear it from the dashboard to resume.`) } catch { /* ignore send failure */ }
      return
    }
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'Run Now kill-switch check failed (fail-closed, aborting)')
    return
  }

  const wasRunning = runningTasks.has(task.id)
  runningTasks.add(task.id)
  if (wasRunning) {
    logger.warn({ taskId: task.id }, 'Task already running, skipping manual trigger')
    return
  }
  logger.info({ taskId: task.id }, 'Running task now (manual trigger)')
  const preview = task.prompt.slice(0, 50)
  const taskProject = getProject(task.project_id)
  const taskProjectSlug = taskProject?.slug
  const agentId = mapTaskToAgent(task.id, taskProjectSlug)

  const nextRun = task.schedule ? computeNextRun(task.schedule) : (Date.now() + 3_600_000) // 1 hour fallback for schedule-less tasks

  // Project-aware sender: prefixes messages with [Project Name] for multi-project visibility
  const psend: Sender = async (chatId, text) => send(chatId, withProject(task.project_id, text))

  // Tracker is set after the preamble is built, just before runAgent()
  let tracker: ReturnType<typeof startRequest> | undefined

  try {
    // Advance next_run immediately to prevent duplicate runs on crash
    if (task.schedule) {
      updateTaskAfterRun(task.id, 'running...', nextRun)
    }

    reportAgentStatus(agentId, 'active', preview, task.project_id)
    reportFeedItem(agentId, 'Task started (manual)', preview, task.project_id)

    // ── Newsletter bypass: same as cron path — run deterministic code, no LLM ──
    if (task.id === 'newsletter-monday' || task.id === 'newsletter-thursday') {
      const result = await generateAndSendNewsletter(task.chat_id, psend)
      updateTaskAfterRun(task.id, result.slice(0, 2000), nextRun)
      reportAgentStatus(agentId, 'idle')
      logger.info({ taskId: task.id }, 'Newsletter task completed (manual)')
      return
    }

    const silent = task.prompt.startsWith('[silent]')
    const basePrompt = silent ? task.prompt.slice('[silent]'.length).trimStart() : task.prompt
    const cleanPrompt = await augmentTaskPrompt(task, basePrompt)

    const { runAgent } = await import('./agent.js')
    let taskPrompt = cleanPrompt
    const soul = getSoul(agentId, taskProjectSlug)
    if (soul) {
      taskPrompt = `${buildAgentPrompt(soul, task.project_id)}\n\n---\n\n${cleanPrompt}`
    }

    // Prepend scheduled task preamble to suppress git-awareness behavior
    // (same as runSingleScheduledTask — agents should not run git commands during manual triggers)
    taskPrompt = `${SCHEDULED_TASK_PREAMBLE}${taskPrompt}`

    tracker = startRequest(
      task.chat_id,
      'scheduler',
      task.prompt.slice(0, 80),
      taskPrompt,
      task.project_id || 'default',
    )
    tracker.setAgentId(agentId)
    tracker.markAgentStarted()

    const agentRes = await runAgent(taskPrompt, undefined, undefined, undefined,
      (event) => tracker?.recordSdkEvent(event),
      {
        projectId: task.project_id || 'default',
        source: agentId,
      }, {
        projectId: task.project_id || 'default',
        agentId,
      })
    const text = agentRes.text

    tracker.markAgentEnded()
    tracker.setExecutionMeta({
      requestedProvider: agentRes.requestedProvider,
      executedProvider: agentRes.executedProvider,
      providerFallbackApplied: agentRes.providerFallbackApplied,
    })
    if (agentRes.text) tracker.setResultText(agentRes.text)
    const result =
      text && text.trim().length > 0
        ? text
        : `Agent returned no text. ${agentRes.emptyReason ?? 'No diagnostic info available.'}\n\nTask: ${preview}\nAgent: ${agentId}\nWhat to do: check the bot logs (npm run logs) for the matching task ID, or rerun the task from the dashboard with Run Now.`

    // Extract and log any research findings
    extractAndLogFindings(result, agentId, task.project_id).catch((err) => {
      logger.warn({ err, taskId: task.id }, 'Research finding extraction failed (manual run)')
    })

    // Persist any action items the agent proposed to the DB
    if (text && text.trim().length > 0 && task.project_id) {
      const parsedItems = parseActionItemsFromAgentOutput(result)
      if (parsedItems.length > 0) {
        ingestParsedItems(parsedItems, {
          project_id: task.project_id,
          source: agentId,
          proposed_by: agentId,
        })
      }
    }

    if (!silent) {
      const notification = text && text.trim().length > 0
        ? summarizeActionItemNotification(agentId, result)
        : summarizeIssueNotification(agentId, preview, agentRes.emptyReason)
      if (notification) {
        await psend(task.chat_id, notification)
      }
    }

    updateTaskAfterRun(task.id, result.slice(0, 2000), nextRun)
    reportAgentStatus(agentId, 'idle', undefined, task.project_id)
    // Store result preview (not prompt) so the dashboard briefing banner shows actual output
    reportFeedItem(agentId, 'Task completed (manual)', result.slice(0, 200), task.project_id)
    syncTasksToDashboard()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    recordError('scheduler', 'error', errMsg, err instanceof Error ? err.stack : undefined, { taskId: task.id, trigger: 'manual' })
    logger.error({ err, taskId: task.id }, 'Manual task run failed')
    await psend(task.chat_id, `\u274C Task failed: ${preview}...\nError: ${errMsg.slice(0, 500)}`).catch(() => {})
    reportAgentStatus(agentId, 'error', errMsg.slice(0, 100), task.project_id)
    reportFeedItem(agentId, 'Task failed (manual)', errMsg.slice(0, 200), task.project_id)
    updateTaskAfterRun(task.id, `ERROR: ${errMsg.slice(0, 1000)}`, nextRun)
    syncTasksToDashboard()
  } finally {
    runningTasks.delete(task.id)
    if (tracker) {
      try {
        tracker.finalize()
      } catch (err) {
        logger.warn({ err }, 'Scheduler telemetry finalize failed (non-fatal)')
      }
      try {
        const row = tracker.toEventRow()
        fetch(`${DASHBOARD_URL}/api/v1/chat/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(BOT_API_TOKEN ? { 'x-dashboard-token': BOT_API_TOKEN } : {}),
          },
          body: JSON.stringify(row),
        }).catch((err: unknown) => {
          logger.warn({ err }, 'Scheduler telemetry sync failed (non-fatal)')
        })
      } catch (err) {
        logger.warn({ err }, 'Scheduler telemetry sync setup failed (non-fatal)')
      }
    }
  }
}

/**
 * Compute the next run time (milliseconds) from a cron expression.
 *
 * Timezone: honors CRON_TZ env var (defaults to America/New_York). Pinning TZ
 * here prevents DST "spring forward" skip + "fall back" duplicate fires, and
 * keeps scheduling stable if the host TZ ever changes (e.g. laptop travel).
 */
const CRON_TZ = process.env.CRON_TZ || 'America/New_York'

export function computeNextRun(cronExpression: string): number {
  const now = Date.now()
  const interval = cronParser.parseExpression(cronExpression, { tz: CRON_TZ })
  let next = interval.next().getTime() // milliseconds, matches Date.now()
  // Guard against edge case where next occurrence is already in the past.
  // Loop (not single retry) so arbitrary clock skew is absorbed.
  while (next <= now) next = interval.next().getTime()
  return next
}

/**
 * Map a scheduled task ID to the corresponding dashboard agent ID.
 */
function mapTaskToAgent(taskId: string, projectSlug?: string): string {
  // Check if task ID contains a known agent ID
  for (const soul of getAllSouls(projectSlug)) {
    if (taskId.includes(soul.id)) return soul.id
  }
  // Legacy fallback mappings
  const legacy: Record<string, string> = {
    'youtube-trend-scanner': 'scout',
    'youtube-weekly-pipeline': 'producer',
    'youtube-linkedin-monitor': 'sentinel',
    'security-daily-scan': 'auditor',
    'security-weekly-audit': 'auditor',
    'newsletter-monday': 'scout',
    'newsletter-thursday': 'scout',
    'metrics-daily-collection': 'scout',
    'daily-backup': 'system',
    'fop-weekly-briefing': 'researcher',
    'fop-weekly-grant-scan': 'researcher',
    'fop-weekly-screenplay-pipeline': 'researcher',
    'fop-weekly-festival-scan': 'festival-strategist',
    'fop-weekly-content-plan': 'marketing-lead',
    'fop-weekly-social-report': 'social-manager',
    'fop-weekly-blog-post': 'content-creator',
    'fop-weekly-blog-draft': 'content-creator',
    'fop-social-crossposter': 'social-manager',
    'fop-monthly-newsletter': 'content-creator',
    'fop-hourly-health-check': 'orchestrator',
    'fop-board-meeting': 'orchestrator',
  }
  return legacy[taskId] ?? 'system'
}
