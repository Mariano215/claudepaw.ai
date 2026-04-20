import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  BOT_TOKEN,
  STORE_DIR,
  PROJECT_ROOT,
  ALLOWED_CHAT_ID,
  CHANNELS_ENABLED,
  DISCORD_BOT_TOKEN,
  DISCORD_ALLOWED_USER_IDS,
  WHATSAPP_AUTH_DIR,
  WHATSAPP_ALLOWED_NUMBERS,
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  SLACK_ALLOWED_USER_IDS,
  IMESSAGE_ALLOWED_HANDLES,
  EMBEDDING_DIMENSIONS,
  DASHBOARD_URL,
  OPERATOR_CHAT_IDS,
} from './config.js'
import { initDatabase, getDb, initVecTable, getTask, createTask, checkpointAndCloseDatabase } from './db.js'
import { initTelemetryDatabase, seedDefaultProject, checkpointAndCloseTelemetryDb } from './telemetry-db.js'
import { recordSystemHealth } from './telemetry.js'
import os from 'node:os'
import { runDecaySweep } from './memory.js'
import { cleanupOldUploads } from './media.js'
import { initScheduler, computeNextRun, stopScheduler } from './scheduler.js'
import { connectDashboard, disconnectDashboard, reportFeedItem, reportBotHealth, reportPlugins, setDashboardSendFn } from './dashboard.js'
import { initSecurity } from './security/index.js'
import { initWebhookDb, startPruneTimer } from './webhooks/index.js'
import { initBuilder } from './builder/index.js'
import { initSocial } from './social/index.js'
import { initNewsletter } from './newsletter/index.js'
import { logger } from './logger.js'
import { loadAllSouls, getAllSouls } from './souls.js'
import { loadAllPlugins } from './plugins/loader.js'
import { listPlugins } from './plugins/registry.js'
import { startSidecar, stopSidecar } from './guard/sidecar.js'
import { processMessage } from './pipeline.js'
import { ChannelManager } from './channels/manager.js'
import { TelegramChannel } from './channels/telegram.js'
import { initCredentialStore, listAllProjectServices, getServiceCredentials, getCredential } from './credentials.js'
import { IMessageChannel } from './channels/imessage.js'
import { DiscordChannel } from './channels/discord.js'
import { WhatsAppChannel } from './channels/whatsapp.js'
import { SlackChannel } from './channels/slack.js'
import type { IncomingMessage } from './channels/types.js'

// ---------------------------------------------------------------------------
// Global error handlers
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection')
})

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception -- shutting down')
  process.exit(1)
})

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

const BANNER = `
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝╚══════╝
 ██████╗  █████╗ ██╗    ██╗
██╔═══██╗██╔══██╗██║    ██║
██║██╗██║███████║██║ █╗ ██║
██║██║██║██╔══██║██║███╗██║
╚█████╔╝██║  ██║╚███╔███╔╝
 ╚════╝ ╚═╝  ╚═╝ ╚══╝╚══╝
`

// ---------------------------------------------------------------------------
// PID lock file
// ---------------------------------------------------------------------------

const PID_FILE = path.join(STORE_DIR, 'claudepaw.pid')

function acquireLock(): void {
  mkdirSync(STORE_DIR, { recursive: true })

  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (!isNaN(oldPid)) {
      try {
        process.kill(oldPid, 0) // check if alive
        logger.warn({ oldPid }, 'Killing stale ClaudePaw process')
        process.kill(oldPid, 'SIGTERM')
      } catch {
        // Process not running, just a stale file
      }
    }
  }

  writeFileSync(PID_FILE, String(process.pid))
  logger.debug({ pid: process.pid }, 'Lock acquired')
}

function releaseLock(): void {
  try {
    unlinkSync(PID_FILE)
  } catch {
    // Already cleaned up
  }
}

// ---------------------------------------------------------------------------
// Channel factory
// ---------------------------------------------------------------------------

function buildChannelManager(): ChannelManager {
  const manager = new ChannelManager()

  // The callback every channel uses to deliver messages to the pipeline
  const onMessage = async (msg: IncomingMessage): Promise<void> => {
    const channel = manager.getChannel(msg.channelId)
    if (!channel) {
      logger.error({ channelId: msg.channelId }, 'Message from unknown channel')
      return
    }
    await processMessage(msg, channel)
  }

  const enabled = new Set(CHANNELS_ENABLED)

  // Telegram
  if (enabled.has('telegram') && BOT_TOKEN) {
    manager.register(
      new TelegramChannel(
        { botToken: BOT_TOKEN, allowedChatIds: ALLOWED_CHAT_ID ? [ALLOWED_CHAT_ID] : [], channelId: 'telegram' },
        onMessage,
      ),
    )
  }

  // Register project-specific Telegram bots from credential store
  try {
    const allServices = listAllProjectServices()
    const projectTelegramEntries = allServices.filter(
      (s) => s.service === 'telegram' && s.keys.includes('bot_token') && s.projectId !== 'default',
    )

    for (const entry of projectTelegramEntries) {
      const creds = getServiceCredentials(entry.projectId, 'telegram')
      if (!creds.bot_token) continue

      const allowedChatIds = creds.allowed_chat_ids
        ? creds.allowed_chat_ids.split(',').map((s: string) => s.trim()).filter(Boolean)
        : []

      manager.register(
        new TelegramChannel(
          {
            botToken: creds.bot_token,
            allowedChatIds,
            projectId: entry.projectId,
            channelId: `telegram:${entry.projectId}`,
          },
          onMessage,
        ),
      )
      logger.info({ projectId: entry.projectId }, 'Registered project Telegram bot')
    }
  } catch (err) {
    logger.warn({ err }, 'Could not load project Telegram bots from credential store')
  }

  // iMessage
  if (enabled.has('imessage') && IMESSAGE_ALLOWED_HANDLES.length > 0) {
    manager.register(
      new IMessageChannel(
        { allowedHandles: IMESSAGE_ALLOWED_HANDLES },
        onMessage,
      ),
    )
  }

  // Discord
  if (enabled.has('discord') && DISCORD_BOT_TOKEN) {
    manager.register(
      new DiscordChannel(
        { botToken: DISCORD_BOT_TOKEN, allowedUserIds: DISCORD_ALLOWED_USER_IDS },
        onMessage,
      ),
    )
  }

  // WhatsApp
  if (enabled.has('whatsapp') && WHATSAPP_ALLOWED_NUMBERS.length > 0) {
    manager.register(
      new WhatsAppChannel(
        { authDir: WHATSAPP_AUTH_DIR, allowedNumbers: WHATSAPP_ALLOWED_NUMBERS },
        onMessage,
      ),
    )
  }

  // Slack
  if (enabled.has('slack') && SLACK_BOT_TOKEN && SLACK_APP_TOKEN) {
    manager.register(
      new SlackChannel(
        { botToken: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, allowedUserIds: SLACK_ALLOWED_USER_IDS },
        onMessage,
      ),
    )
  }

  return manager
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(BANNER)

  // 0. Check .env exists
  const envPath = path.join(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) {
    logger.fatal('No .env file found. Run: cp .env.example .env && npm run setup')
    process.exit(1)
  }

  // 1. Check at least one channel is configured
  if (CHANNELS_ENABLED.length === 0) {
    logger.fatal('No channels enabled -- set CHANNELS_ENABLED in .env')
    process.exit(1)
  }

  logger.info(
    { channels: CHANNELS_ENABLED, chatId: ALLOWED_CHAT_ID ? '***' + String(ALLOWED_CHAT_ID).slice(-4) : undefined, projectRoot: PROJECT_ROOT },
    'Starting ClaudePaw',
  )

  // 2. Acquire lock
  acquireLock()

  // 3. Init database
  const db = initDatabase()

  // Layer 4: initialize vec_embeddings table (creates it if missing)
  try {
    initVecTable(getDb(), EMBEDDING_DIMENSIONS)
  } catch (err) {
    // vec_embeddings init is best-effort; bot runs without it
  }

  // 3a0. Init credential store
  initCredentialStore(db)

  // 3a. Init webhook tables (uses bot DB)
  initWebhookDb(db)
  startPruneTimer()

  // 3b. Init telemetry database + seed default project
  initTelemetryDatabase()
  seedDefaultProject()

  // 3b. Load agent souls
  loadAllSouls()

  // 3b2. Load plugins
  loadAllPlugins()

  // 3c. Init security scanner system
  initSecurity()

  // 3d. Init builder memory
  initBuilder()

  // 3e. Init social posting
  initSocial(db)

  // 3f. Init newsletter
  initNewsletter()

  // 3f. Start guard sidecar (non-blocking -- continues if sidecar fails)
  startSidecar().catch((err) => {
    logger.warn({ err }, 'Guard sidecar failed to start, ML layers will be degraded')
  })

  // 3g. Health poller -- record system metrics every 30s
  const collectHealth = () => {
    try {
      const cpus = os.cpus()
      const cpuIdle = cpus.reduce((sum, c) => sum + c.times.idle, 0)
      const cpuTotal = cpus.reduce((sum, c) => sum + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq, 0)
      const cpuPercent = cpuTotal > 0 ? ((cpuTotal - cpuIdle) / cpuTotal) * 100 : 0

      const snapshot = {
        cpu_percent: Math.round(cpuPercent * 100) / 100,
        memory_used_bytes: os.totalmem() - os.freemem(),
        memory_total_bytes: os.totalmem(),
        disk_used_bytes: 0, // disk stats require async calls, skipping for now
        disk_total_bytes: 0,
        uptime_seconds: os.uptime(),
        node_rss_bytes: process.memoryUsage.rss(),
        bot_pid: process.pid,
        bot_alive: true,
      }
      recordSystemHealth(snapshot)
      reportBotHealth({ ...snapshot, recorded_at: Date.now() })
    } catch (err) {
      logger.error({ err }, 'Health collection failed')
    }
  }
  const healthInterval = setInterval(collectHealth, 30_000)
  collectHealth() // record immediately on startup

  // 4. Memory decay sweep + daily interval
  runDecaySweep()
  setInterval(runDecaySweep, 24 * 60 * 60 * 1000)

  // 5. Connect to dashboard server
  connectDashboard()
  reportFeedItem('system', 'ClaudePaw started', `PID ${process.pid} | Channels: ${CHANNELS_ENABLED.join(', ')}`)

  // Sync loaded plugins to dashboard
  const loadedPlugins = listPlugins().map((p) => ({
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    author: p.manifest.author,
    description: p.manifest.description,
    keywords: p.manifest.keywords,
    agent_id: p.manifest.agent_id,
    dependencies: p.manifest.dependencies,
    enabled: p.enabled,
  }))
  if (loadedPlugins.length > 0) {
    reportPlugins(loadedPlugins)
  }

  // 6. Cleanup old uploads
  cleanupOldUploads()

  // 7. Build and start channel manager
  const channelManager = buildChannelManager()
  await channelManager.startAll()

  // 8. Init scheduler -- wired to channel manager
  const sendFn = async (chatId: string, text: string): Promise<void> => {
    // Default to Telegram for backward compatibility with existing scheduled tasks
    await channelManager.send('telegram', chatId, text)
  }
  // Paw-scoped sender: carries an optional inline keyboard to Telegram.
  const pawSendFn: import('./paws/types.js').PawSender = async (chatId, text, keyboard) => {
    if (keyboard) {
      for (const ch of channelManager.getRunningChannels()) {
        if (typeof (ch as any).sendWithKeyboard === 'function') {
          try {
            await (ch as any).sendWithKeyboard(chatId, text, keyboard)
            return
          } catch { /* try next channel */ }
        }
      }
      // Fallback: channel has no keyboard capability — send plain text.
    }
    await channelManager.send('telegram', chatId, text)
  }

  // Legacy approval sender kept for scheduled-task paths that still use it.
  const sendApprovalFn = async (chatId: string, text: string, pawId: string): Promise<void> => {
    const keyboard = {
      inline_keyboard: [[
        { text: 'Approve', callback_data: `paw:approve:${pawId}` },
        { text: 'Skip', callback_data: `paw:skip:${pawId}` },
      ]],
    }
    await pawSendFn(chatId, text, keyboard)
  }

  initScheduler(sendFn, sendApprovalFn, pawSendFn)


  // Register weekly skill synthesis task if not already present
  const existingSynthTask = getTask('learning-weekly-synthesis')
  if (!existingSynthTask) {
    const schedule = '0 3 * * 0' // Sunday 3am
    createTask(
      'learning-weekly-synthesis',
      String(ALLOWED_CHAT_ID),
      'Run weekly skill synthesis -- analyze failure feedback and create/update learned skills',
      schedule,
      computeNextRun(schedule),
    )
    logger.info('Registered weekly skill synthesis task')
  }

  // 8b. Wire dashboard security trigger send function
  setDashboardSendFn(sendFn)

  // 9. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...')
    reportFeedItem('system', 'ClaudePaw shutting down', signal)
    clearInterval(healthInterval)
    stopScheduler()
    stopSidecar()
    disconnectDashboard()
    await channelManager.stopAll()
    checkpointAndCloseTelemetryDb()
    checkpointAndCloseDatabase()
    releaseLock()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  const running = channelManager.getRunningChannels()
  if (running.length === 0) {
    logger.fatal('No channels started -- check your .env configuration')
    releaseLock()
    process.exit(1)
  }

  logger.info(
    { running: running.map((c) => c.id) },
    'ClaudePaw is running',
  )

  // Human-readable startup summary (plain text, not JSON)
  const agentCount = getAllSouls().length
  const channelNames = running.map((c) => c.id).join(', ')
  console.log('')
  console.log(`  Channels:  ${channelNames}`)
  console.log(`  Agents:    ${agentCount} loaded`)
  console.log(`  Dashboard: ${DASHBOARD_URL || 'not configured'}`)
  console.log(`  Store:     ${STORE_DIR}`)
  console.log('')
  console.log('  ClaudePaw is running. Send a message to your bot to get started.')
  console.log('')
}

main().catch((err) => {
  logger.fatal({ err }, 'Unhandled error')
  releaseLock()
  process.exit(1)
})
