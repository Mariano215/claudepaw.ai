import Database from 'better-sqlite3'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

let db: Database.Database

export function getTelemetryDb(): Database.Database {
  if (!db) {
    mkdirSync(STORE_DIR, { recursive: true })
    const dbPath = resolve(STORE_DIR, 'telemetry.db')
    try {
      db = new Database(dbPath)
      db.pragma('journal_mode = WAL')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!message.toLowerCase().includes('malformed') && !message.toLowerCase().includes('corrupt')) {
        throw err
      }

      logger.error({ err, dbPath }, 'Telemetry DB corrupted; quarantining and rebuilding')

      try { db?.close() } catch { /* ignore */ }
      db = undefined as unknown as Database.Database

      if (existsSync(dbPath)) {
        const quarantinePath = `${dbPath}.corrupt.${Date.now()}`
        renameSync(dbPath, quarantinePath)
        logger.warn({ dbPath, quarantinePath }, 'Moved corrupted telemetry DB aside')
      }

      db = new Database(dbPath)
      db.pragma('journal_mode = WAL')
    }
  }
  return db
}

export function checkpointAndCloseTelemetryDb(): void {
  if (!db) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (err) {
    logger.warn({ err }, 'Failed to checkpoint telemetry database before shutdown')
  }
  try {
    db.close()
  } catch (err) {
    logger.warn({ err }, 'Failed to close telemetry database before shutdown')
  } finally {
    db = undefined as unknown as Database.Database
  }
}

export function initTelemetryDatabase(): void {
  const d = getTelemetryDb()

  // Projects
  d.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      host TEXT NOT NULL DEFAULT 'local',
      connection_type TEXT NOT NULL DEFAULT 'local' CHECK(connection_type IN ('local','ssh','api')),
      connection_config TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','error')),
      agent_count INTEGER DEFAULT 0,
      last_sync_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // Agents
  d.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL,
      emoji TEXT,
      role TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('online','idle','sleeping','offline','destroyed')),
      system_prompt TEXT,
      tools TEXT,
      disallowed_tools TEXT,
      mcp_servers TEXT,
      heartbeat_cron TEXT,
      heartbeat_prompt TEXT,
      active_hours TEXT,
      reports_to TEXT,
      communicates_with TEXT,
      workspace_path TEXT,
      responsibilities TEXT,
      last_active_at INTEGER,
      total_cost_usd REAL DEFAULT 0,
      total_invocations INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      destroyed_at INTEGER
    )
  `)

  // Agent events -- one row per runAgent() call
      d.exec(`
    CREATE TABLE IF NOT EXISTS agent_events (
      event_id TEXT PRIMARY KEY,
      project_id TEXT DEFAULT 'claudepaw',
      chat_id TEXT,
      session_id TEXT,
      received_at INTEGER,
      memory_injected_at INTEGER,
      agent_started_at INTEGER,
      agent_ended_at INTEGER,
      response_sent_at INTEGER,
      prompt_summary TEXT,
      result_summary TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      total_cost_usd REAL,
      duration_ms REAL,
      duration_api_ms REAL,
      num_turns INTEGER,
      is_error INTEGER DEFAULT 0,
      source TEXT CHECK(source IN ('telegram','scheduler','api','dashboard')),
      model_usage_json TEXT,
      requested_provider TEXT,
      executed_provider TEXT,
      provider_fallback_applied INTEGER DEFAULT 0
    )
  `)

  // Tool calls -- FK to agent_events
  d.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL REFERENCES agent_events(event_id),
      tool_use_id TEXT,
      tool_name TEXT,
      parent_tool_use_id TEXT,
      elapsed_seconds REAL
    )
  `)

  // Kanban cards
  d.exec(`
    CREATE TABLE IF NOT EXISTS kanban_cards (
      id TEXT PRIMARY KEY,
      project_id TEXT DEFAULT 'claudepaw',
      title TEXT NOT NULL,
      description TEXT,
      column_name TEXT NOT NULL DEFAULT 'backlog' CHECK(column_name IN ('backlog','todo','in_progress','review','done','archived')),
      priority INTEGER DEFAULT 0,
      sort_order REAL DEFAULT 0,
      tags TEXT,
      linked_event_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // System health snapshots
  d.exec(`
    CREATE TABLE IF NOT EXISTS system_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT DEFAULT 'claudepaw',
      cpu_percent REAL,
      memory_used_bytes INTEGER,
      memory_total_bytes INTEGER,
      disk_used_bytes INTEGER,
      disk_total_bytes INTEGER,
      uptime_seconds REAL,
      node_rss_bytes INTEGER,
      bot_pid INTEGER,
      bot_alive INTEGER DEFAULT 1,
      recorded_at INTEGER NOT NULL
    )
  `)

  // Voice events (STT/TTS)
  d.exec(`
    CREATE TABLE IF NOT EXISTS voice_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT DEFAULT 'claudepaw',
      event_id TEXT,
      direction TEXT CHECK(direction IN ('stt','tts')),
      started_at INTEGER,
      ended_at INTEGER,
      duration_ms REAL,
      success INTEGER DEFAULT 1,
      error_message TEXT,
      audio_size_bytes INTEGER
    )
  `)

  // Error log
  d.exec(`
    CREATE TABLE IF NOT EXISTS error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT DEFAULT 'claudepaw',
      subsystem TEXT,
      severity TEXT CHECK(severity IN ('info','warn','error','fatal')),
      message TEXT NOT NULL,
      stack TEXT,
      context_json TEXT,
      event_id TEXT,
      recorded_at INTEGER NOT NULL
    )
  `)

  // Cost line items (subscriptions, fixed costs)
  d.exec(`
    CREATE TABLE IF NOT EXISTS cost_line_items (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      period TEXT NOT NULL DEFAULT 'monthly' CHECK(period IN ('monthly','yearly','one-time')),
      active INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `)

  // Seed Claude Max subscription
  d.exec(`
    INSERT OR IGNORE INTO cost_line_items (id, label, amount_usd, period, active, created_at)
    VALUES ('claude-max', 'Claude Max Subscription', 200.00, 'monthly', 1, ${Date.now()})
  `)

  // Indexes
  d.exec(`CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id, status)`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_events_project ON agent_events(project_id, received_at)`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_health_recorded ON system_health(recorded_at)`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_errors_recorded ON error_log(recorded_at)`)

  // Safe re-runnable column migrations (duplicate column errors are swallowed)
  const runMigration = (sql: string): void => {
    try {
      d.exec(sql)
    } catch (e: unknown) {
      if (!(e instanceof Error && e.message.includes('duplicate column'))) throw e
    }
  }
  runMigration(`ALTER TABLE agent_events ADD COLUMN prompt_text TEXT`)
  runMigration(`ALTER TABLE agent_events ADD COLUMN result_text TEXT`)
  runMigration(`ALTER TABLE agent_events ADD COLUMN agent_id TEXT`)
  runMigration(`ALTER TABLE agent_events ADD COLUMN requested_provider TEXT`)
  runMigration(`ALTER TABLE agent_events ADD COLUMN executed_provider TEXT`)
  runMigration(`ALTER TABLE agent_events ADD COLUMN provider_fallback_applied INTEGER DEFAULT 0`)

  // Tool invocation tracking (#17) -- per-tool timing + outcome on the existing tool_calls table.
  // Secrets in `tool_input_summary` are redacted + truncated to 200 chars in src/telemetry.ts.
  runMigration(`ALTER TABLE tool_calls ADD COLUMN started_at INTEGER`)
  runMigration(`ALTER TABLE tool_calls ADD COLUMN duration_ms INTEGER`)
  runMigration(`ALTER TABLE tool_calls ADD COLUMN tool_input_summary TEXT`)
  runMigration(`ALTER TABLE tool_calls ADD COLUMN success INTEGER`)
  runMigration(`ALTER TABLE tool_calls ADD COLUMN error TEXT`)
  // Index for per-event tool lookups (dashboard drill-in) and per-tool aggregates
  d.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_event ON tool_calls(event_id)`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_name_started ON tool_calls(tool_name, started_at)`)

  // Event sync retry queue -- tracks events that failed to POST to Hostinger.
  // seedSyncQueue() in event-sync.ts populates this on startup; retryUnsyncedEvents()
  // drains it every 5 min. INSERT OR IGNORE on both sides makes it idempotent.
  d.exec(`
    CREATE TABLE IF NOT EXISTS event_sync_queue (
      event_id         TEXT PRIMARY KEY,
      queued_at        INTEGER NOT NULL,
      retry_count      INTEGER NOT NULL DEFAULT 0,
      last_attempt_at  INTEGER
    )
  `)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_sync_queue_queued ON event_sync_queue(queued_at)`)

  logger.info('Telemetry database initialized')
}

export function seedDefaultProject(): void {
  const d = getTelemetryDb()
  try {
    const existing = d
      .prepare('SELECT id FROM projects WHERE id = ?')
      .get('claudepaw') as { id: string } | undefined

    if (!existing) {
      const now = Date.now()
      d.prepare(
        `INSERT INTO projects (id, name, description, host, connection_type, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('claudepaw', 'ClaudePaw', 'Telegram bot bridging to Claude Code SDK', 'local', 'local', 'active', now, now)
      logger.info('Seeded default claudepaw project')
    }
  } catch (err) {
    logger.error({ err }, 'Failed to seed default project')
  }
}
