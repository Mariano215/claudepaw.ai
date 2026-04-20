import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, statSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'
import { logger } from './logger.js'
import { PERSONAL_AGENTS, getAgentsForProject } from './agents.js'
import { runServerMigrations } from './migrations.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '..', 'store', 'claudepaw-server.db')
const TELEMETRY_DB_PATH = path.join(__dirname, '..', 'store', 'telemetry.db')
const REPO_BOT_DB_PATH = path.join(__dirname, '..', '..', 'store', 'claudepaw.db')
const LEGACY_BOT_DB_PATH = path.join(__dirname, '..', 'store', 'claudepaw.db')

function fileSize(pathname: string): number {
  try {
    return statSync(pathname).size
  } catch {
    return -1
  }
}

// Path to the main bot database -- override via BOT_DB_PATH env var.
// Prefer the repo-level store used by the bot process. Fall back to the old
// server-local path only when that file is the only populated candidate.
export function resolveBotDbPath(explicitPath = process.env.BOT_DB_PATH): string {
  if (explicitPath) return explicitPath

  const repoSize = fileSize(REPO_BOT_DB_PATH)
  const legacySize = fileSize(LEGACY_BOT_DB_PATH)

  if (repoSize > 0) return REPO_BOT_DB_PATH
  if (legacySize > 0) return LEGACY_BOT_DB_PATH
  if (repoSize === 0 && legacySize < 0) return REPO_BOT_DB_PATH
  if (legacySize === 0 && repoSize < 0) return LEGACY_BOT_DB_PATH

  return REPO_BOT_DB_PATH
}

const BOT_DB_PATH = resolveBotDbPath()

let botDbReadonly: Database.Database | null = null
let botDbWrite: Database.Database | null = null

// SQLite does not support parameterized PRAGMA arguments, so we interpolate.
// Validate identifiers here to keep hasColumn safe even if a future caller
// passes config-derived or plugin-provided table/column names.
//
// MIRROR: src/db.ts has an identical copy. Both are deployed independently
// (bot vs dashboard), so they can't share a module via tsconfig rootDir
// boundaries. Keep both in sync if the grammar ever needs to change.
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
function assertSqliteIdentifier(name: string, kind: 'table' | 'column'): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`Invalid SQLite ${kind} identifier: ${JSON.stringify(name)}`)
  }
}

function hasColumn(dbh: Database.Database, table: string, column: string): boolean {
  assertSqliteIdentifier(table, 'table')
  assertSqliteIdentifier(column, 'column')
  const cols = dbh.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some(col => col.name === column)
}

export function ensureActionItemsResearchLink(dbh: Database.Database): void {
  if (!hasColumn(dbh, 'action_items', 'research_item_id')) {
    dbh.exec(`ALTER TABLE action_items ADD COLUMN research_item_id TEXT DEFAULT NULL`)
  }
  dbh.exec(`CREATE INDEX IF NOT EXISTS idx_action_items_research ON action_items(research_item_id)`)
}

function ensureBotProjectLifecycleSchema(dbh: Database.Database): void {
  if (!hasColumn(dbh, 'projects', 'status')) {
    dbh.exec(`ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived'))`)
  }
  if (!hasColumn(dbh, 'projects', 'updated_at')) {
    dbh.exec(`ALTER TABLE projects ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`)
    dbh.exec(`UPDATE projects SET updated_at = created_at WHERE updated_at = 0`)
  }
  if (!hasColumn(dbh, 'projects', 'paused_at')) {
    dbh.exec(`ALTER TABLE projects ADD COLUMN paused_at INTEGER`)
  }
  if (!hasColumn(dbh, 'projects', 'archived_at')) {
    dbh.exec(`ALTER TABLE projects ADD COLUMN archived_at INTEGER`)
  }
  if (!hasColumn(dbh, 'projects', 'auto_archive_days')) {
    dbh.exec(`ALTER TABLE projects ADD COLUMN auto_archive_days INTEGER`)
  }
  if (!hasColumn(dbh, 'project_settings', 'execution_provider')) {
    dbh.exec(`ALTER TABLE project_settings ADD COLUMN execution_provider TEXT`)
  }
  if (!hasColumn(dbh, 'project_settings', 'execution_provider_secondary')) {
    dbh.exec(`ALTER TABLE project_settings ADD COLUMN execution_provider_secondary TEXT`)
  }
  if (!hasColumn(dbh, 'project_settings', 'execution_provider_fallback')) {
    dbh.exec(`ALTER TABLE project_settings ADD COLUMN execution_provider_fallback TEXT`)
  }
  if (!hasColumn(dbh, 'project_settings', 'execution_model')) {
    dbh.exec(`ALTER TABLE project_settings ADD COLUMN execution_model TEXT`)
  }
  if (!hasColumn(dbh, 'project_settings', 'execution_model_primary')) {
    dbh.exec(`ALTER TABLE project_settings ADD COLUMN execution_model_primary TEXT`)
  }
  if (!hasColumn(dbh, 'project_settings', 'execution_model_secondary')) {
    dbh.exec(`ALTER TABLE project_settings ADD COLUMN execution_model_secondary TEXT`)
  }
  if (!hasColumn(dbh, 'project_settings', 'execution_model_fallback')) {
    dbh.exec(`ALTER TABLE project_settings ADD COLUMN execution_model_fallback TEXT`)
  }
  if (!hasColumn(dbh, 'project_settings', 'fallback_policy')) {
    dbh.exec(`ALTER TABLE project_settings ADD COLUMN fallback_policy TEXT`)
  }
  if (!hasColumn(dbh, 'project_settings', 'model_tier')) {
    dbh.exec(`ALTER TABLE project_settings ADD COLUMN model_tier TEXT`)
  }
  if (!hasColumn(dbh, 'project_settings', 'monthly_cost_cap_usd')) {
    dbh.exec(`ALTER TABLE project_settings ADD COLUMN monthly_cost_cap_usd REAL`)
  }
  if (!hasColumn(dbh, 'project_settings', 'daily_cost_cap_usd')) {
    dbh.exec(`ALTER TABLE project_settings ADD COLUMN daily_cost_cap_usd REAL`)
  }
}

/** Open the bot DB in read-only mode (for GET queries). Returns null if file not found. */
export function getBotDb(): Database.Database | null {
  if (botDbReadonly) return botDbReadonly
  try {
    if (!existsSync(BOT_DB_PATH)) {
      logger.warn({ path: BOT_DB_PATH }, 'Bot DB not found')
      return null
    }
    const writable = getBotDbWrite()
    if (writable) ensureBotProjectLifecycleSchema(writable)
    botDbReadonly = new Database(BOT_DB_PATH, { readonly: true })
    botDbReadonly.pragma('journal_mode = WAL')
    return botDbReadonly
  } catch (err) {
    logger.error({ err }, 'Failed to open bot DB (readonly)')
    return null
  }
}

/** Open the bot DB with write access (for PATCH/mutations). Returns null if file not found. */
export function getBotDbWrite(): Database.Database | null {
  if (botDbWrite) return botDbWrite
  try {
    if (!existsSync(BOT_DB_PATH)) {
      logger.warn({ path: BOT_DB_PATH }, 'Bot DB not found')
      return null
    }
    botDbWrite = new Database(BOT_DB_PATH)
    botDbWrite.pragma('journal_mode = WAL')
    ensureBotProjectLifecycleSchema(botDbWrite)
    ensureActionItemsResearchLink(botDbWrite)
    return botDbWrite
  } catch (err) {
    logger.error({ err }, 'Failed to open bot DB (write)')
    return null
  }
}

export interface ScheduledTask {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused'
  project_id: string
  created_at: number
}

export function getAllScheduledTasks(projectId?: string, allowedProjectIds?: string[] | null): ScheduledTask[] {
  if (projectId) {
    return db.prepare('SELECT * FROM scheduled_tasks WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as ScheduledTask[]
  }
  if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return []
    const ph = allowedProjectIds.map(() => '?').join(', ')
    return db.prepare(`SELECT * FROM scheduled_tasks WHERE project_id IN (${ph}) ORDER BY created_at DESC`).all(...allowedProjectIds) as ScheduledTask[]
  }
  return db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[]
}

export function getScheduledTask(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined
}

export function updateScheduledTaskStatus(id: string, status: 'active' | 'paused'): boolean {
  const result = db.prepare("UPDATE scheduled_tasks SET status = ? WHERE id = ?").run(status, id)
  return result.changes > 0
}

export function createScheduledTask(task: {
  id: string
  chat_id: string
  prompt: string
  schedule: string
  next_run: number
  status?: string
  project_id?: string
}): void {
  db.prepare(`
    INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, last_run, last_result, status, created_at, project_id)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
  `).run(task.id, task.chat_id, task.prompt, task.schedule, task.next_run, task.status || 'active', Date.now(), task.project_id || 'default')
}

export function updateScheduledTask(id: string, updates: { prompt?: string; schedule?: string; chat_id?: string }): boolean {
  const sets: string[] = []
  const values: unknown[] = []
  if (updates.prompt !== undefined) { sets.push('prompt = ?'); values.push(updates.prompt) }
  if (updates.schedule !== undefined) { sets.push('schedule = ?'); values.push(updates.schedule) }
  if (updates.chat_id !== undefined) { sets.push('chat_id = ?'); values.push(updates.chat_id) }
  if (updates.schedule !== undefined) {
    try {
      const interval = CronExpressionParser.parse(updates.schedule)
      const nextRun = interval.next().getTime()
      sets.push('next_run = ?')
      values.push(nextRun)
    } catch (e) {
      // invalid cron -- don't update next_run
    }
  }
  if (sets.length === 0) return false
  values.push(id)
  const result = db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return result.changes > 0
}

export function deleteScheduledTask(id: string): boolean {
  const result = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
  return result.changes > 0
}

/** Sync scheduled tasks from the bot -- upsert all, remove stale ones scoped to project */
export function syncScheduledTasks(tasks: ScheduledTask[], projectId: string = 'default'): void {
  const upsert = db.prepare(`
    INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, last_run, last_result, status, created_at, project_id)
    VALUES (@id, @chat_id, @prompt, @schedule, @next_run, @last_run, @last_result, @status, @created_at, @project_id)
    ON CONFLICT(id) DO UPDATE SET
      prompt = excluded.prompt,
      schedule = excluded.schedule,
      next_run = excluded.next_run,
      last_run = excluded.last_run,
      last_result = excluded.last_result,
      status = excluded.status,
      project_id = excluded.project_id
  `)

  const tx = db.transaction(() => {
    for (const task of tasks) {
      upsert.run({ ...task, project_id: projectId })
    }
    // NOTE: We no longer delete orphaned tasks here because the bot sends
    // per-project batches sequentially. Deleting during the first batch
    // (e.g. 'default') would remove tasks that belong to other projects
    // before those batches arrive to reassign them. Orphan cleanup is handled
    // by the bot only sending active tasks -- stale ones just get overwritten.
  })
  tx()
  logger.info({ count: tasks.length, projectId }, 'Scheduled tasks synced from bot')
}

let telemetryDb: Database.Database | null = null

export function getTelemetryDb(): Database.Database | null {
  if (telemetryDb) return telemetryDb
  try {
    if (!existsSync(TELEMETRY_DB_PATH)) return null
    telemetryDb = new Database(TELEMETRY_DB_PATH)
    telemetryDb.pragma('journal_mode = WAL')
    // Ensure required tables exist (telemetry.db may be fresh or synced without all tables)
    telemetryDb.exec(`
      CREATE TABLE IF NOT EXISTS agent_events (
        event_id TEXT PRIMARY KEY,
        project_id TEXT DEFAULT 'claudepaw',
        chat_id TEXT, session_id TEXT,
        received_at INTEGER, memory_injected_at INTEGER,
        agent_started_at INTEGER, agent_ended_at INTEGER, response_sent_at INTEGER,
        prompt_summary TEXT, result_summary TEXT, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
        total_cost_usd REAL, duration_ms REAL, duration_api_ms REAL,
        num_turns INTEGER, is_error INTEGER DEFAULT 0,
        source TEXT, model_usage_json TEXT,
        prompt_text TEXT, result_text TEXT, agent_id TEXT,
        requested_provider TEXT, executed_provider TEXT,
        provider_fallback_applied INTEGER DEFAULT 0
      )
    `)
    if (!hasColumn(telemetryDb, 'agent_events', 'prompt_text')) {
      telemetryDb.exec(`ALTER TABLE agent_events ADD COLUMN prompt_text TEXT`)
    }
    if (!hasColumn(telemetryDb, 'agent_events', 'result_text')) {
      telemetryDb.exec(`ALTER TABLE agent_events ADD COLUMN result_text TEXT`)
    }
    if (!hasColumn(telemetryDb, 'agent_events', 'agent_id')) {
      telemetryDb.exec(`ALTER TABLE agent_events ADD COLUMN agent_id TEXT`)
    }
    if (!hasColumn(telemetryDb, 'agent_events', 'requested_provider')) {
      telemetryDb.exec(`ALTER TABLE agent_events ADD COLUMN requested_provider TEXT`)
    }
    if (!hasColumn(telemetryDb, 'agent_events', 'executed_provider')) {
      telemetryDb.exec(`ALTER TABLE agent_events ADD COLUMN executed_provider TEXT`)
    }
    if (!hasColumn(telemetryDb, 'agent_events', 'provider_fallback_applied')) {
      telemetryDb.exec(`ALTER TABLE agent_events ADD COLUMN provider_fallback_applied INTEGER DEFAULT 0`)
    }
    telemetryDb.exec(`
      CREATE TABLE IF NOT EXISTS cost_line_items (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        period TEXT NOT NULL DEFAULT 'monthly' CHECK(period IN ('monthly','yearly','one-time')),
        active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL
      )
    `)
    telemetryDb.exec(`
      INSERT OR IGNORE INTO cost_line_items (id, label, amount_usd, period, active, created_at)
      VALUES ('claude-max', 'Claude Max Subscription', 200.00, 'monthly', 1, ${Date.now()})
    `)
    return telemetryDb
  } catch {
    return null
  }
}

export interface ChatMessage {
  event_id: string
  received_at: number
  prompt_text: string | null
  result_text: string | null
  prompt_summary: string
  result_summary: string
  source: string
  model: string
  duration_ms: number
  total_cost_usd: number
  is_error: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  agent_id: string | null
  requested_provider: string | null
  executed_provider: string | null
  provider_fallback_applied: number
  tool_calls: Array<{ tool_name: string; elapsed_seconds: number }>
}

export function queryChatMessages(params: {
  limit?: number
  before?: number
  projectId?: string
  /**
   * Three-state project scope: `null` means admin (no filter), `[]` means the
   * caller has access to no projects (return empty), `string[]` restricts the
   * query to those project ids. If `projectId` is also supplied, it must be a
   * subset of `allowedProjectIds` or we return empty.
   */
  allowedProjectIds?: string[] | null
}): { data: ChatMessage[]; has_more: boolean } {
  const tdb = getTelemetryDb()
  if (!tdb) return { data: [], has_more: false }

  // Fast path: caller has no project access → no rows.
  if (Array.isArray(params.allowedProjectIds) && params.allowedProjectIds.length === 0) {
    return { data: [], has_more: false }
  }

  const limit = Math.min(params.limit ?? 50, 200)
  const conditions: string[] = []
  const values: (string | number)[] = []

  if (params.before) {
    conditions.push('e.received_at < ?')
    values.push(params.before)
  }

  if (params.projectId) {
    // Explicit single-project filter. Must be allowed by scope if scope is set.
    if (Array.isArray(params.allowedProjectIds) && !params.allowedProjectIds.includes(params.projectId)) {
      return { data: [], has_more: false }
    }
    conditions.push('e.project_id = ?')
    values.push(params.projectId)
  } else if (Array.isArray(params.allowedProjectIds)) {
    // No explicit project, but caller is a non-admin member: restrict to their
    // allowed set. Admins (allowedProjectIds === null) fall through unfiltered.
    const placeholders = params.allowedProjectIds.map(() => '?').join(', ')
    conditions.push(`e.project_id IN (${placeholders})`)
    values.push(...params.allowedProjectIds)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = tdb.prepare(`
    SELECT
      e.event_id, e.received_at,
      e.prompt_text, e.result_text,
      e.prompt_summary, e.result_summary,
      e.source, e.model, e.duration_ms, e.total_cost_usd,
      e.is_error, e.input_tokens, e.output_tokens, e.cache_read_tokens,
      e.agent_id, e.requested_provider, e.executed_provider, e.provider_fallback_applied
    FROM agent_events e
    ${where}
    ORDER BY e.received_at DESC
    LIMIT ?
  `).all(...values, limit + 1) as ChatMessage[]

  const has_more = rows.length > limit
  if (has_more) rows.pop()

  const stmtTools = tdb.prepare(
    'SELECT tool_name, elapsed_seconds FROM tool_calls WHERE event_id = ? ORDER BY id'
  )
  for (const row of rows) {
    row.tool_calls = stmtTools.all(row.event_id) as Array<{ tool_name: string; elapsed_seconds: number }>
  }

  return { data: rows, has_more }
}

/**
 * Insert or ignore an agent_events row into the telemetry DB.
 * Used by the REST endpoints that receive synced events from the Mac bot.
 */
export function insertChatEvent(row: Record<string, unknown>): void {
  const tdb = getTelemetryDb()
  if (!tdb) return
  tdb.prepare(`
    INSERT OR IGNORE INTO agent_events (
      event_id, project_id, chat_id, session_id,
      received_at, memory_injected_at, agent_started_at, agent_ended_at, response_sent_at,
      prompt_summary, result_summary, model,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      total_cost_usd, duration_ms, duration_api_ms, num_turns, is_error,
      source, model_usage_json, prompt_text, result_text, agent_id,
      requested_provider, executed_provider, provider_fallback_applied
    ) VALUES (
      @event_id, @project_id, @chat_id, @session_id,
      @received_at, @memory_injected_at, @agent_started_at, @agent_ended_at, @response_sent_at,
      @prompt_summary, @result_summary, @model,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
      @total_cost_usd, @duration_ms, @duration_api_ms, @num_turns, @is_error,
      @source, @model_usage_json, @prompt_text, @result_text, @agent_id,
      @requested_provider, @executed_provider, @provider_fallback_applied
    )
  `).run({
    event_id: row.event_id ?? null,
    project_id: row.project_id ?? 'default',
    chat_id: row.chat_id ?? null,
    session_id: row.session_id ?? null,
    received_at: row.received_at ?? null,
    memory_injected_at: row.memory_injected_at ?? null,
    agent_started_at: row.agent_started_at ?? null,
    agent_ended_at: row.agent_ended_at ?? null,
    response_sent_at: row.response_sent_at ?? null,
    prompt_summary: row.prompt_summary ?? null,
    result_summary: row.result_summary ?? null,
    model: row.model ?? null,
    input_tokens: row.input_tokens ?? null,
    output_tokens: row.output_tokens ?? null,
    cache_read_tokens: row.cache_read_tokens ?? null,
    cache_creation_tokens: row.cache_creation_tokens ?? null,
    total_cost_usd: row.total_cost_usd ?? null,
    duration_ms: row.duration_ms ?? null,
    duration_api_ms: row.duration_api_ms ?? null,
    num_turns: row.num_turns ?? null,
    is_error: row.is_error ?? 0,
    source: row.source ?? null,
    model_usage_json: row.model_usage_json ?? null,
    prompt_text: row.prompt_text ?? null,
    result_text: row.result_text ?? null,
    agent_id: row.agent_id ?? null,
    requested_provider: row.requested_provider ?? null,
    executed_provider: row.executed_provider ?? null,
    provider_fallback_applied: row.provider_fallback_applied ?? 0,
  })
}

let db: Database.Database

export function initDatabase(): Database.Database {
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'on-demand' CHECK(mode IN ('always-on','active','on-demand')),
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('online','active','idle','sleeping','error')),
      current_task TEXT,
      last_active INTEGER,
      heartbeat_interval TEXT DEFAULT '1h',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'task' CHECK(type IN ('task','result','info','error','handoff')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','read','completed')),
      created_at INTEGER NOT NULL,
      delivered_at INTEGER,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_messages_agent_status ON messages(to_agent, status);

    CREATE TABLE IF NOT EXISTS feed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_feed_created ON feed(created_at DESC);

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value REAL NOT NULL,
      metadata TEXT,
      recorded_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_metrics_category_time ON metrics(category, recorded_at);

    CREATE TABLE IF NOT EXISTS api_call_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      endpoint TEXT,
      status_code INTEGER,
      is_quota_error INTEGER DEFAULT 0,
      error_message TEXT,
      duration_ms INTEGER,
      called_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_api_log_platform_time ON api_call_log(platform, called_at);

    CREATE TABLE IF NOT EXISTS api_quota_state (
      platform TEXT PRIMARY KEY,
      daily_limit INTEGER,
      last_quota_error_at INTEGER,
      cooldown_until INTEGER,
      last_error_message TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status_next ON scheduled_tasks(status, next_run);

    CREATE TABLE IF NOT EXISTS security_findings (
      id TEXT PRIMARY KEY,
      scanner_id TEXT NOT NULL,
      severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      target TEXT NOT NULL,
      auto_fixable INTEGER DEFAULT 0,
      auto_fixed INTEGER DEFAULT 0,
      fix_description TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','fixed','acknowledged','false-positive')),
      first_seen INTEGER NOT NULL, -- SECONDS (not ms): intentional legacy convention, see CLAUDE.md
      last_seen INTEGER NOT NULL, -- SECONDS (not ms): intentional legacy convention, see CLAUDE.md
      resolved_at INTEGER, -- SECONDS (not ms): intentional legacy convention, see CLAUDE.md
      metadata TEXT DEFAULT '{}',
      UNIQUE(scanner_id, title, target)
    );
    CREATE INDEX IF NOT EXISTS idx_findings_status ON security_findings(status);
    CREATE INDEX IF NOT EXISTS idx_findings_severity ON security_findings(severity);

    CREATE TABLE IF NOT EXISTS security_scans (
      id TEXT PRIMARY KEY,
      scanner_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER,
      findings_count INTEGER DEFAULT 0,
      trigger TEXT NOT NULL CHECK(trigger IN ('scheduled','manual'))
    );
    CREATE INDEX IF NOT EXISTS idx_scans_started ON security_scans(started_at DESC);

    CREATE TABLE IF NOT EXISTS research_items (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      source_url TEXT DEFAULT '',
      category TEXT NOT NULL DEFAULT 'cyber' CHECK(category IN ('cyber','ai','tools','general','real-estate','business')),
      score INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewing','opportunity','published','archived','considering','analyzed','passed','offer')),
      pipeline TEXT DEFAULT '' CHECK(pipeline IN ('','idea','draft','scheduled','live','considering','analyzed','passed','offer')),
      competitor TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      found_by TEXT DEFAULT 'scout',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_research_category ON research_items(category);
    CREATE INDEX IF NOT EXISTS idx_research_status ON research_items(status);
    CREATE INDEX IF NOT EXISTS idx_research_created ON research_items(created_at DESC);

    CREATE TABLE IF NOT EXISTS research_chat_messages (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'agent')),
      body TEXT NOT NULL,
      agent_job TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rs_chat_messages_item ON research_chat_messages(item_id);

    CREATE TABLE IF NOT EXISTS security_auto_fixes (
      id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL,
      scanner_id TEXT NOT NULL,
      action TEXT NOT NULL,
      success INTEGER NOT NULL,
      detail TEXT,
      -- TODO (review finding M1): created_at is written as Unix epoch seconds
      -- (see src/security/persistence.ts logAutoFix), which violates the
      -- "milliseconds everywhere" rule in CLAUDE.md. Migrating to ms is
      -- deferred to a future task -- annotation only for now.
      created_at INTEGER NOT NULL -- SECONDS (not ms): intentional legacy convention, see CLAUDE.md
    );

    CREATE TABLE IF NOT EXISTS security_score_history (
      date TEXT PRIMARY KEY,
      score INTEGER NOT NULL,
      critical_count INTEGER DEFAULT 0,
      high_count INTEGER DEFAULT 0,
      medium_count INTEGER DEFAULT 0,
      low_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS board_meetings (
      id          TEXT PRIMARY KEY,
      date        TEXT NOT NULL,
      briefing    TEXT NOT NULL,
      metrics_snapshot TEXT DEFAULT '{}',
      agent_highlights TEXT DEFAULT '[]',
      status      TEXT DEFAULT 'draft' CHECK(status IN ('draft','approved','revised')),
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS board_decisions (
      id          TEXT PRIMARY KEY,
      meeting_id  TEXT NOT NULL,
      description TEXT NOT NULL,
      status      TEXT DEFAULT 'open' CHECK(status IN ('open','resolved','deferred','cancelled')),
      resolved_at INTEGER,
      created_at  INTEGER NOT NULL,
      project_id  TEXT DEFAULT 'default'
    );

    CREATE INDEX IF NOT EXISTS idx_board_decisions_meeting ON board_decisions(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_board_decisions_status ON board_decisions(status);

    CREATE TABLE IF NOT EXISTS channel_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      channel TEXT NOT NULL,
      channel_name TEXT,
      bot_name TEXT,
      project_id TEXT DEFAULT 'default',
      chat_id TEXT,
      sender_name TEXT,
      agent_id TEXT,
      content TEXT,
      content_type TEXT DEFAULT 'text',
      is_voice INTEGER DEFAULT 0,
      is_group INTEGER DEFAULT 0,
      duration_ms INTEGER,
      tokens_used INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_log_project ON channel_log(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_log_channel ON channel_log(channel, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_log_time ON channel_log(created_at DESC);

    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      author TEXT NOT NULL,
      description TEXT NOT NULL,
      keywords TEXT DEFAULT '[]',
      agent_id TEXT,
      dependencies TEXT DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      installed_at INTEGER NOT NULL
    );
  `)

  // --- Project-scoping migrations ---
  const projectMigrations = [
    `ALTER TABLE research_items ADD COLUMN project_id TEXT DEFAULT 'default'`,
    `ALTER TABLE board_meetings ADD COLUMN project_id TEXT DEFAULT 'default'`,
    `ALTER TABLE board_decisions ADD COLUMN project_id TEXT DEFAULT 'default'`,
    `ALTER TABLE security_score_history ADD COLUMN project_id TEXT DEFAULT 'default'`,
    `ALTER TABLE security_findings ADD COLUMN project_id TEXT DEFAULT 'default'`,
    `ALTER TABLE security_scans ADD COLUMN project_id TEXT DEFAULT 'default'`,
    `ALTER TABLE feed ADD COLUMN project_id TEXT DEFAULT 'default'`,
    `ALTER TABLE scheduled_tasks ADD COLUMN project_id TEXT DEFAULT 'default'`,
    `ALTER TABLE agents ADD COLUMN project_id TEXT DEFAULT 'default'`,
    `ALTER TABLE agents ADD COLUMN template_id TEXT`,
    `ALTER TABLE messages ADD COLUMN project_id TEXT DEFAULT 'default'`,
    `ALTER TABLE metrics ADD COLUMN project_id TEXT DEFAULT 'default'`,
    `ALTER TABLE security_auto_fixes ADD COLUMN project_id TEXT DEFAULT 'default'`,
    `ALTER TABLE research_items ADD COLUMN last_investigated_at INTEGER DEFAULT NULL`,
  ]
  for (const sql of projectMigrations) {
    try {
      db.exec(sql)
    } catch (err: any) {
      if (!err?.message?.includes('duplicate column')) {
        logger.error({ err }, 'Unexpected ALTER TABLE error')
      }
    }
  }

  // Backfill template_id for existing agents
  try { db.exec(`UPDATE agents SET template_id = id WHERE template_id IS NULL`) } catch { /* already done */ }

  // Backfill board_decisions.project_id from parent board_meetings
  try {
    db.exec(
      'UPDATE board_decisions SET project_id = (' +
      'SELECT bm.project_id FROM board_meetings bm WHERE bm.id = board_decisions.meeting_id' +
      ') WHERE project_id = \'default\' OR project_id IS NULL'
    )
  } catch { /* already done or column doesn\'t exist yet */ }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id);
    CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id);
  `)
  // Note: skip UNIQUE index on (project_id, template_id) -- can't guarantee uniqueness on existing data

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_findings_project ON security_findings(project_id);
    CREATE INDEX IF NOT EXISTS idx_scans_project ON security_scans(project_id);
    CREATE INDEX IF NOT EXISTS idx_research_project ON research_items(project_id);
    CREATE INDEX IF NOT EXISTS idx_board_meetings_project ON board_meetings(project_id);
    CREATE INDEX IF NOT EXISTS idx_board_decisions_project ON board_decisions(project_id);
    CREATE INDEX IF NOT EXISTS idx_feed_project_created ON feed(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_metrics_project ON metrics(project_id, category, recorded_at);
  `)

  // Backfill scheduled_tasks project_id by task ID prefix
  try {
    db.exec(`UPDATE scheduled_tasks SET project_id = 'example-company'    WHERE project_id = 'default' AND id IN ('fop-board-meeting','fop-weekly-blog-post','fop-weekly-briefing','fop-weekly-content-plan','fop-weekly-festival-scan','fop-weekly-grant-scan','fop-weekly-screenplay-pipeline','fop-weekly-social-report')`)
    db.exec(`UPDATE scheduled_tasks SET project_id = 'default'  WHERE project_id = 'default' AND id IN ('youtube-linkedin-monitor','youtube-trend-scanner','youtube-weekly-pipeline')`)
    db.exec(`UPDATE scheduled_tasks SET project_id = 'claudepaw'       WHERE project_id = 'default' AND id = 'oss-health-check'`)
  } catch { /* already done */ }

  // Backfill metrics project_id from key prefixes
  try {
    db.exec(`UPDATE metrics SET project_id = 'example-company' WHERE project_id = 'default' AND (key LIKE 'fop-%' OR category LIKE 'telegram:example-company%')`)
    db.exec(`UPDATE metrics SET project_id = 'example-company' WHERE project_id = 'default' AND (key LIKE 'ap-%' OR category LIKE 'telegram:example-company%')`)
    db.exec(`UPDATE metrics SET project_id = 'default' WHERE project_id = 'default' AND (key LIKE 'website-%' OR key LIKE 'website-%' OR category LIKE 'telegram:default%')`)
    // Normalize telegram categories back to bare category after backfill
    db.exec(`UPDATE metrics SET category = 'telegram' WHERE category LIKE 'telegram:%'`)
  } catch { /* already done */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      display_name TEXT NOT NULL,
      handle TEXT,
      metric_prefix TEXT,
      config TEXT DEFAULT '{}',
      sort_order INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE(project_id, platform, handle)
    );
    CREATE INDEX IF NOT EXISTS idx_integrations_project ON project_integrations(project_id);

    CREATE TABLE IF NOT EXISTS metric_health (
      integration_id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      metric_prefix TEXT NOT NULL,
      status TEXT NOT NULL,
      last_check INTEGER NOT NULL,
      last_success INTEGER,
      attempts INTEGER DEFAULT 0,
      reason TEXT,
      missing_keys TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_metric_health_project ON metric_health(project_id);
    CREATE INDEX IF NOT EXISTS idx_metric_health_status ON metric_health(status);

    CREATE TABLE IF NOT EXISTS action_item_chat_messages (
      id          TEXT PRIMARY KEY,
      item_id     TEXT NOT NULL,
      role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'agent')),
      body        TEXT NOT NULL,
      agent_job   TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_item ON action_item_chat_messages(item_id);
    CREATE TABLE IF NOT EXISTS paws (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      name        TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      cron        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active',
      config      TEXT NOT NULL DEFAULT '{}',
      next_run    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paw_cycles (
      id              TEXT PRIMARY KEY,
      paw_id          TEXT NOT NULL,
      started_at      INTEGER NOT NULL,
      phase           TEXT NOT NULL DEFAULT 'observe',
      state           TEXT NOT NULL DEFAULT '{}',
      findings        TEXT NOT NULL DEFAULT '[]',
      actions_taken   TEXT NOT NULL DEFAULT '[]',
      report          TEXT,
      completed_at    INTEGER,
      error           TEXT
    );
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
    CREATE TABLE IF NOT EXISTS system_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      kill_switch_at INTEGER,
      kill_switch_reason TEXT,
      kill_switch_set_by TEXT,
      updated_at INTEGER NOT NULL
    );
    -- Phase 5 Task 3 -- append-only kill-switch transition log.
    -- Sibling of system_state; weekly report joins this for intra-week
    -- toggle counts.
    CREATE TABLE IF NOT EXISTS kill_switch_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      toggled_at_ms  INTEGER NOT NULL,
      new_state      TEXT NOT NULL CHECK (new_state IN ('tripped', 'active')),
      reason         TEXT,
      set_by         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_kill_switch_log_toggled_at ON kill_switch_log(toggled_at_ms DESC);
  `)
  db.prepare('INSERT OR IGNORE INTO system_state (id, updated_at) VALUES (1, ?)').run(Date.now())

  // Run versioned migrations (additive only, never drops data)
  runServerMigrations(db)

  seedAgents()
  seedProjectIntegrations()
  logger.info({ path: DB_PATH }, 'Database initialized')
  return db
}

/** Returns the server database instance. Must be called after initDatabase(). */
export function getServerDb(): Database.Database {
  return db
}

function seedAgents(): void {
  const count = db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number }
  if (count.c > 0) return

  const insert = db.prepare(`
    INSERT INTO agents (id, name, role, emoji, mode, status, heartbeat_interval, project_id, template_id, created_at)
    VALUES (@id, @name, @role, @emoji, @mode, 'idle', @heartbeat_interval, 'default', @id, @created_at)
  `)

  const now = Date.now()
  const tx = db.transaction(() => {
    for (const agent of PERSONAL_AGENTS) {
      insert.run({ ...agent, created_at: now })
    }
  })
  tx()
  logger.info({ count: PERSONAL_AGENTS.length }, 'Seeded personal assistant agents')
}

/** Seed the default agent roster for a project. Skips if agents already exist. */
export function seedProjectAgents(projectId: string): Agent[] {
  // Check if project already has agents
  const existing = db.prepare('SELECT COUNT(*) as c FROM agents WHERE project_id = ?').get(projectId) as { c: number }
  if (existing.c > 0) {
    return getAllAgents(projectId)
  }

  // Inline the projectAgentId logic to avoid dynamic import in sync function
  const makeAgentId = (pid: string, tid: string) => pid === 'default' ? tid : `${pid}--${tid}`

  const insert = db.prepare(`
    INSERT INTO agents (id, name, role, emoji, mode, status, heartbeat_interval, project_id, template_id, created_at)
    VALUES (@id, @name, @role, @emoji, @mode, 'idle', @heartbeat_interval, @project_id, @template_id, @created_at)
  `)

  const now = Date.now()
  const roster = getAgentsForProject(projectId)
  const tx = db.transaction(() => {
    for (const agent of roster) {
      insert.run({
        id: makeAgentId(projectId, agent.id),
        name: agent.name,
        role: agent.role,
        emoji: agent.emoji,
        mode: agent.mode,
        heartbeat_interval: agent.heartbeat_interval,
        project_id: projectId,
        template_id: agent.id,
        created_at: now,
      })
    }
  })
  tx()

  return getAllAgents(projectId)
}

function seedProjectIntegrations(): void {
  const count = (db.prepare('SELECT COUNT(*) as c FROM project_integrations').get() as { c: number }).c
  if (count > 0) return

  const insert = db.prepare(`
    INSERT OR IGNORE INTO project_integrations (project_id, platform, display_name, handle, metric_prefix, config, sort_order, enabled, created_at)
    VALUES (@project_id, @platform, @display_name, @handle, @metric_prefix, @config, @sort_order, @enabled, @created_at)
  `)

  const now = Date.now()
  const tx = db.transaction(() => {
    const integrations = [
      // default project -- customize these for your setup
      { project_id: 'default', platform: 'website', display_name: 'Website', handle: 'example.com', metric_prefix: 'website', sort_order: 0 },
      { project_id: 'default', platform: 'x-twitter', display_name: 'X / Twitter', handle: '@your_handle', metric_prefix: 'twitter', sort_order: 1 },
      { project_id: 'default', platform: 'linkedin', display_name: 'LinkedIn', handle: 'in/your-profile', metric_prefix: 'linkedin', sort_order: 2 },
      { project_id: 'default', platform: 'youtube', display_name: 'YouTube', handle: '@your_channel', metric_prefix: 'youtube', sort_order: 3 },
      // example-company project
      { project_id: 'example-company', platform: 'website', display_name: 'Website', handle: 'example-company.com', metric_prefix: 'ec-website', sort_order: 0 },
      { project_id: 'example-company', platform: 'instagram', display_name: 'Instagram', handle: '@example_company', metric_prefix: 'ec-instagram', sort_order: 1 },
    ]
    for (const row of integrations) {
      insert.run({ ...row, config: '{}', enabled: 1, created_at: now })
    }
  })
  tx()
  logger.info('Seeded default project integrations')
}

// --- Agents ---

export interface Agent {
  id: string
  name: string
  role: string
  emoji: string
  mode: string
  status: string
  current_task: string | null
  last_active: number | null
  heartbeat_interval: string | null
  project_id: string
  template_id: string | null
  created_at: number
}

export function getAgent(id: string): Agent | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined
}

export function getAllAgents(projectId?: string, allowedProjectIds?: string[] | null): Agent[] {
  if (projectId) {
    return db.prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at').all(projectId) as Agent[]
  }
  if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return []
    const ph = allowedProjectIds.map(() => '?').join(', ')
    return db.prepare(`SELECT * FROM agents WHERE project_id IN (${ph}) ORDER BY created_at`).all(...allowedProjectIds) as Agent[]
  }
  return db.prepare('SELECT * FROM agents ORDER BY created_at').all() as Agent[]
}

export function updateAgentStatus(id: string, status: string, task?: string | null): void {
  db.prepare(`
    UPDATE agents SET status = ?, current_task = ?, last_active = ? WHERE id = ?
  `).run(status, task ?? null, Date.now(), id)
}

export function resetAllActiveAgents(): { id: string; status: string; project_id: string }[] {
  db.prepare(`UPDATE agents SET status = 'idle', current_task = NULL WHERE status = 'active'`).run()
  return db.prepare(`SELECT id, status, project_id FROM agents`).all() as { id: string; status: string; project_id: string }[]
}

const ALLOWED_AGENT_FIELDS = ['name', 'status', 'model', 'role', 'emoji', 'mode', 'current_task', 'heartbeat_interval', 'config', 'project_id', 'template_id']

export function upsertAgent(agent: Partial<Agent> & { id: string }): void {
  const existing = getAgent(agent.id)
  if (existing) {
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, val] of Object.entries(agent)) {
      if (key === 'id' || !ALLOWED_AGENT_FIELDS.includes(key)) continue
      fields.push(`${key} = ?`)
      values.push(val)
    }
    if (fields.length === 0) return
    values.push(agent.id)
    db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  } else {
    db.prepare(`
      INSERT INTO agents (id, name, role, emoji, mode, status, heartbeat_interval, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.id,
      agent.name ?? agent.id,
      agent.role ?? 'General',
      agent.emoji ?? '',
      agent.mode ?? 'on-demand',
      agent.status ?? 'idle',
      agent.heartbeat_interval ?? '1h',
      agent.created_at ?? Date.now()
    )
  }
}

export function deleteAgent(id: string): boolean {
  const agent = db.prepare('SELECT project_id FROM agents WHERE id = ?').get(id) as { project_id: string } | undefined
  if (!agent) return false
  return db.prepare('DELETE FROM agents WHERE id = ?').run(id).changes > 0
}

// --- Messages ---

export interface Message {
  id: number
  from_agent: string
  to_agent: string
  content: string
  type: string
  status: string
  created_at: number
  delivered_at: number | null
  completed_at: number | null
}

export function sendMessage(from: string, to: string, content: string, type: string = 'task'): Message {
  const now = Date.now()
  const result = db.prepare(`
    INSERT INTO messages (from_agent, to_agent, content, type, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(from, to, content, type, now)

  return db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid) as Message
}

export function getMessagesForAgent(agentId: string, status?: string): Message[] {
  if (status) {
    return db.prepare('SELECT * FROM messages WHERE to_agent = ? AND status = ? ORDER BY created_at DESC')
      .all(agentId, status) as Message[]
  }
  return db.prepare('SELECT * FROM messages WHERE to_agent = ? ORDER BY created_at DESC')
    .all(agentId) as Message[]
}

export function markDelivered(id: number): void {
  db.prepare('UPDATE messages SET status = ?, delivered_at = ? WHERE id = ?')
    .run('delivered', Date.now(), id)
}

export function markCompleted(id: number): void {
  db.prepare('UPDATE messages SET status = ?, completed_at = ? WHERE id = ?')
    .run('completed', Date.now(), id)
}

export function getRecentMessages(limit: number = 50, projectId?: string, allowedProjectIds?: string[] | null): Message[] {
  if (projectId) {
    return db.prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(projectId, limit) as Message[]
  }
  if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return []
    const ph = allowedProjectIds.map(() => '?').join(', ')
    return db.prepare(`SELECT * FROM messages WHERE project_id IN (${ph}) ORDER BY created_at DESC LIMIT ?`).all(...allowedProjectIds, limit) as Message[]
  }
  return db.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Message[]
}

// --- Feed ---

export interface FeedItem {
  id: number
  agent_id: string
  action: string
  detail: string | null
  created_at: number
  project_id?: string
}

export function addFeedItem(agentId: string, action: string, detail?: string | null, projectId?: string): FeedItem {
  const now = Date.now()
  const result = db.prepare(`
    INSERT INTO feed (agent_id, action, detail, project_id, created_at) VALUES (?, ?, ?, ?, ?)
  `).run(agentId, action, detail ?? null, projectId ?? 'default', now)
  return db.prepare('SELECT * FROM feed WHERE id = ?').get(result.lastInsertRowid) as FeedItem
}

/**
 * Lists feed items, optionally filtered.
 *
 * allowedProjectIds semantics (shared by all scoped list helpers):
 *   - null or undefined: admin bypass, no project filter applied
 *   - []: caller has zero project access, returns empty immediately
 *   - string[]: filter to only these project IDs via AND project_id IN (...)
 */
export function getRecentFeed(limit: number = 50, sinceId?: number, projectId?: string, agentId?: string, allowedProjectIds?: string[] | null): FeedItem[] {
  const conditions: string[] = []
  const params: unknown[] = []
  if (sinceId) { conditions.push('id > ?'); params.push(sinceId) }
  if (projectId) {
    conditions.push('project_id = ?'); params.push(projectId)
  } else if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return []
    const ph = allowedProjectIds.map(() => '?').join(', ')
    conditions.push(`project_id IN (${ph})`)
    params.push(...allowedProjectIds)
  }
  if (agentId) { conditions.push('agent_id = ?'); params.push(agentId) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return db.prepare(`SELECT * FROM feed ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as FeedItem[]
}

// --- Metrics ---

export interface Metric {
  id: number
  category: string
  key: string
  value: number
  metadata: string | null
  recorded_at: number
  project_id: string
}

export function recordMetric(category: string, key: string, value: number, metadata?: string | null, projectId?: string): void {
  db.prepare(`
    INSERT INTO metrics (category, key, value, metadata, recorded_at, project_id) VALUES (?, ?, ?, ?, ?, ?)
  `).run(category, key, value, metadata ?? null, Date.now(), projectId ?? 'default')
}

export function getMetrics(category: string, since?: number, projectId?: string, allowedProjectIds?: string[] | null): Metric[] {
  const conditions = ['category = ?']
  const params: unknown[] = [category]
  if (since) { conditions.push('recorded_at >= ?'); params.push(since) }
  if (projectId) {
    conditions.push('project_id = ?'); params.push(projectId)
  } else if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return []
    const ph = allowedProjectIds.map(() => '?').join(', ')
    conditions.push(`project_id IN (${ph})`)
    params.push(...allowedProjectIds)
  }
  const where = `WHERE ${conditions.join(' AND ')}`
  const limit = since ? 'LIMIT 10000' : 'LIMIT 100'
  return db.prepare(`SELECT * FROM metrics ${where} ORDER BY recorded_at DESC ${limit}`)
    .all(...params) as Metric[]
}

export function getDb(): Database.Database {
  return db
}

// --- Security ---

export interface SecurityFinding {
  id: string
  scanner_id: string
  severity: string
  title: string
  description: string
  target: string
  auto_fixable: number
  auto_fixed: number
  fix_description: string | null
  status: string
  first_seen: number
  last_seen: number
  resolved_at: number | null
  metadata: string
}

export interface SecurityScan {
  id: string
  scanner_id: string
  started_at: number
  duration_ms: number | null
  findings_count: number
  trigger: string
}

export interface SecurityAutoFix {
  id: string
  finding_id: string
  scanner_id: string
  action: string
  success: number
  detail: string | null
  created_at: number
}

export interface SecurityScore {
  date: string
  score: number
  critical_count: number
  high_count: number
  medium_count: number
  low_count: number
}

/** Upsert a single finding. On conflict (scanner_id, title, target), updates last_seen and other fields. */
export function upsertSecurityFinding(f: Record<string, unknown>): void {
  const id = (f.id ?? f.findingId) as string
  const scannerId = (f.scanner_id ?? f.scannerId) as string
  const severity = f.severity as string
  const title = f.title as string
  const description = (f.description ?? '') as string
  const target = f.target as string
  const autoFixable = f.auto_fixable ?? f.autoFixable ?? 0
  const autoFixed = f.auto_fixed ?? f.autoFixed ?? 0
  const fixDescription = (f.fix_description ?? f.fixDescription ?? null) as string | null
  const status = (f.status ?? 'open') as string
  // security_findings.first_seen / last_seen use SECONDS (legacy convention, see CLAUDE.md)
  let firstSeen = (f.first_seen ?? f.firstSeen ?? Math.floor(Date.now() / 1000)) as number
  let lastSeen = (f.last_seen ?? f.lastSeen ?? Math.floor(Date.now() / 1000)) as number
  if (firstSeen > 1e10) firstSeen = Math.floor(firstSeen / 1000)
  if (lastSeen > 1e10) lastSeen = Math.floor(lastSeen / 1000)
  const resolvedAt = (f.resolved_at ?? f.resolvedAt ?? null) as number | null
  const metadata = typeof f.metadata === 'string' ? f.metadata : JSON.stringify(f.metadata ?? {})
  const projectId = (f.project_id ?? f.projectId ?? 'default') as string

  db.prepare(`
    INSERT INTO security_findings (id, scanner_id, severity, title, description, target, auto_fixable, auto_fixed, fix_description, status, first_seen, last_seen, resolved_at, metadata, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scanner_id, title, target) DO UPDATE SET
      severity = excluded.severity,
      description = excluded.description,
      auto_fixable = excluded.auto_fixable,
      auto_fixed = excluded.auto_fixed,
      fix_description = excluded.fix_description,
      status = CASE WHEN security_findings.status IN ('acknowledged','false-positive') THEN security_findings.status ELSE excluded.status END,
      last_seen = excluded.last_seen,
      resolved_at = excluded.resolved_at,
      metadata = excluded.metadata,
      project_id = excluded.project_id
  `).run(id, scannerId, severity, title, description, target, autoFixable ? 1 : 0, autoFixed ? 1 : 0, fixDescription, status, firstSeen, lastSeen, resolvedAt, metadata, projectId)
}

export interface FindingsFilter {
  severity?: string
  scanner_id?: string
  status?: string
  project_id?: string
  allowedProjectIds?: string[] | null
  limit?: number
  offset?: number
}

export function getSecurityFindings(filter: FindingsFilter = {}): { findings: SecurityFinding[]; total: number } {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.severity) {
    conditions.push('severity = ?')
    params.push(filter.severity)
  }
  if (filter.scanner_id) {
    conditions.push('scanner_id = ?')
    params.push(filter.scanner_id)
  }
  if (filter.status) {
    conditions.push('status = ?')
    params.push(filter.status)
  }
  if (filter.project_id) {
    conditions.push('project_id = ?')
    params.push(filter.project_id)
  } else if (Array.isArray(filter.allowedProjectIds)) {
    if (filter.allowedProjectIds.length === 0) return { findings: [], total: 0 }
    const ph = filter.allowedProjectIds.map(() => '?').join(', ')
    conditions.push(`project_id IN (${ph})`)
    params.push(...filter.allowedProjectIds)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const total = (db.prepare(`SELECT COUNT(*) as c FROM security_findings ${where}`).get(...params) as { c: number }).c

  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0
  const findings = db.prepare(`SELECT * FROM security_findings ${where} ORDER BY last_seen DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as SecurityFinding[]

  return { findings, total }
}

export function updateSecurityFindingStatus(id: string, status: string): boolean {
  // security_findings uses seconds (legacy: first_seen/last_seen are seconds too)
  const resolvedAt = (status === 'fixed' || status === 'false-positive') ? Math.floor(Date.now() / 1000) : null
  const result = db.prepare('UPDATE security_findings SET status = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?')
    .run(status, resolvedAt, id)
  return result.changes > 0
}

export function recordSecurityScan(s: Record<string, unknown>, projectId: string = 'default'): void {
  const id = (s.id ?? s.scanId) as string
  const scannerId = (s.scanner_id ?? s.scannerId) as string
  const startedAt = (s.started_at ?? s.startedAt ?? Date.now()) as number
  const durationMs = (s.duration_ms ?? s.durationMs ?? null) as number | null
  const findingsCount = (s.findings_count ?? s.findingsCount ?? 0) as number
  const triggerType = (s.trigger_type ?? s.triggerType ?? s.trigger ?? 'manual') as string
  const pid = (s.project_id ?? s.projectId ?? projectId) as string

  db.prepare(`
    INSERT OR REPLACE INTO security_scans (id, scanner_id, started_at, duration_ms, findings_count, trigger, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, scannerId, startedAt, durationMs, findingsCount, triggerType, pid)
}

export function getSecurityScans(limit: number = 50, projectId?: string, allowedProjectIds?: string[] | null): SecurityScan[] {
  if (projectId) {
    return db.prepare('SELECT * FROM security_scans WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(projectId, limit) as SecurityScan[]
  }
  if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return []
    const ph = allowedProjectIds.map(() => '?').join(', ')
    return db.prepare(`SELECT * FROM security_scans WHERE project_id IN (${ph}) ORDER BY started_at DESC LIMIT ?`).all(...allowedProjectIds, limit) as SecurityScan[]
  }
  return db.prepare('SELECT * FROM security_scans ORDER BY started_at DESC LIMIT ?').all(limit) as SecurityScan[]
}

export function upsertSecurityScore(s: Record<string, unknown>, projectId: string = 'default'): void {
  const date = (s.date ?? new Date().toISOString().slice(0, 10)) as string
  const score = (s.score ?? 100) as number
  const criticalCount = (s.critical_count ?? s.criticalCount ?? 0) as number
  const highCount = (s.high_count ?? s.highCount ?? 0) as number
  const mediumCount = (s.medium_count ?? s.mediumCount ?? 0) as number
  const lowCount = (s.low_count ?? s.lowCount ?? 0) as number
  const pid = (s.project_id ?? s.projectId ?? projectId) as string

  db.prepare(`
    INSERT OR REPLACE INTO security_score_history (date, score, critical_count, high_count, medium_count, low_count, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(date, score, criticalCount, highCount, mediumCount, lowCount, pid)
}

export function getSecurityScore(projectId?: string, allowedProjectIds?: string[] | null): { current: SecurityScore | null; history: SecurityScore[] } {
  if (projectId) {
    const current = db.prepare('SELECT * FROM security_score_history WHERE project_id = ? ORDER BY date DESC LIMIT 1').get(projectId) as SecurityScore | undefined
    const history = db.prepare('SELECT * FROM security_score_history WHERE project_id = ? ORDER BY date DESC LIMIT 90').all(projectId) as SecurityScore[]
    return { current: current ?? null, history }
  }
  if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return { current: null, history: [] }
    const ph = allowedProjectIds.map(() => '?').join(', ')
    const current = db.prepare(`SELECT * FROM security_score_history WHERE project_id IN (${ph}) ORDER BY date DESC LIMIT 1`).get(...allowedProjectIds) as SecurityScore | undefined
    const history = db.prepare(`SELECT * FROM security_score_history WHERE project_id IN (${ph}) ORDER BY date DESC LIMIT 90`).all(...allowedProjectIds) as SecurityScore[]
    return { current: current ?? null, history }
  }
  const current = db.prepare('SELECT * FROM security_score_history ORDER BY date DESC LIMIT 1').get() as SecurityScore | undefined
  const history = db.prepare('SELECT * FROM security_score_history ORDER BY date DESC LIMIT 90').all() as SecurityScore[]
  return { current: current ?? null, history }
}

export function getSecurityAutoFixes(
  limit: number = 50,
  projectId?: string,
  allowedProjectIds?: string[] | null,
): SecurityAutoFix[] {
  // Three-state scope (consistent with other list helpers):
  // - allowedProjectIds === null / undefined → admin (no filter)
  // - allowedProjectIds === []               → no access (empty)
  // - allowedProjectIds === string[]         → restrict via IN
  if (Array.isArray(allowedProjectIds) && allowedProjectIds.length === 0) return []
  if (projectId) {
    if (Array.isArray(allowedProjectIds) && !allowedProjectIds.includes(projectId)) return []
    return db.prepare('SELECT * FROM security_auto_fixes WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as SecurityAutoFix[]
  }
  if (Array.isArray(allowedProjectIds)) {
    const placeholders = allowedProjectIds.map(() => '?').join(', ')
    return db.prepare(
      `SELECT * FROM security_auto_fixes WHERE project_id IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`,
    ).all(...allowedProjectIds, limit) as SecurityAutoFix[]
  }
  return db.prepare('SELECT * FROM security_auto_fixes ORDER BY created_at DESC LIMIT ?').all(limit) as SecurityAutoFix[]
}

export function recordSecurityAutoFix(f: Record<string, unknown>, projectId: string = 'default'): void {
  const id = (f.id ?? f.fixId) as string
  const findingId = (f.finding_id ?? f.findingId) as string
  const scannerId = (f.scanner_id ?? f.scannerId) as string
  const action = f.action as string
  const success = (f.success ?? 0) as number
  const detail = (f.detail ?? null) as string | null
  const createdAt = (f.created_at ?? f.createdAt ?? Date.now()) as number
  const pid = (f.project_id ?? f.projectId ?? projectId) as string

  db.prepare(`
    INSERT OR REPLACE INTO security_auto_fixes (id, finding_id, scanner_id, action, success, detail, created_at, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, findingId, scannerId, action, success ? 1 : 0, detail, createdAt, pid)
}

// --- Research ---

export interface ResearchItem {
  id: string
  project_id: string
  topic: string
  source: string
  source_url: string
  category: string
  score: number
  status: string
  pipeline: string
  competitor: string
  notes: string
  found_by: string
  created_at: number
  updated_at: number
  last_investigated_at: number | null
}

export interface ResearchFilter {
  category?: string
  status?: string
  pipeline?: string
  project_id?: string
  allowedProjectIds?: string[] | null
  limit?: number
  offset?: number
}

// --- Board Meetings ---

export interface BoardMeeting {
  id: string
  date: string
  briefing: string
  metrics_snapshot: string
  agent_highlights: string
  status: string
  created_at: number
}

export interface BoardDecision {
  id: string
  meeting_id: string
  description: string
  status: string
  resolved_at: number | null
  created_at: number
}

export function getResearchItems(filter: ResearchFilter = {}): { items: ResearchItem[]; total: number } {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.category) {
    conditions.push('category = ?')
    params.push(filter.category)
  }
  if (filter.status) {
    conditions.push('status = ?')
    params.push(filter.status)
  }
  if (filter.pipeline) {
    conditions.push('pipeline = ?')
    params.push(filter.pipeline)
  }
  if (filter.project_id) {
    conditions.push('project_id = ?')
    params.push(filter.project_id)
  } else if (Array.isArray(filter.allowedProjectIds)) {
    if (filter.allowedProjectIds.length === 0) return { items: [], total: 0 }
    const ph = filter.allowedProjectIds.map(() => '?').join(', ')
    conditions.push(`project_id IN (${ph})`)
    params.push(...filter.allowedProjectIds)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const total = (db.prepare(`SELECT COUNT(*) as c FROM research_items ${where}`).get(...params) as { c: number }).c

  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0
  const items = db.prepare(`SELECT * FROM research_items ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as ResearchItem[]

  return { items, total }
}

export function getResearchItem(id: string): ResearchItem | undefined {
  return db.prepare('SELECT * FROM research_items WHERE id = ?').get(id) as ResearchItem | undefined
}

export function upsertResearchItem(item: Record<string, unknown>): void {
  const id = item.id as string
  const topic = item.topic as string
  const source = (item.source ?? '') as string
  const sourceUrl = (item.source_url ?? item.sourceUrl ?? '') as string
  const category = (item.category ?? 'general') as string
  const score = (item.score ?? 0) as number
  const status = (item.status ?? 'new') as string
  const pipeline = (item.pipeline ?? '') as string
  const competitor = (item.competitor ?? '') as string
  const notes = (item.notes ?? '') as string
  const foundBy = (item.found_by ?? item.foundBy ?? 'scout') as string
  const projectId = (item.project_id ?? item.projectId ?? 'default') as string
  const now = Date.now()
  const createdAt = (item.created_at ?? item.createdAt ?? now) as number
  const updatedAt = now

  db.prepare(`
    INSERT INTO research_items (id, topic, source, source_url, category, score, status, pipeline, competitor, notes, found_by, created_at, updated_at, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      topic = excluded.topic,
      source = excluded.source,
      source_url = excluded.source_url,
      category = excluded.category,
      score = excluded.score,
      status = excluded.status,
      pipeline = excluded.pipeline,
      competitor = excluded.competitor,
      notes = excluded.notes,
      found_by = excluded.found_by,
      updated_at = excluded.updated_at,
      project_id = excluded.project_id
  `).run(id, topic, source, sourceUrl, category, score, status, pipeline, competitor, notes, foundBy, createdAt, updatedAt, projectId)
}

export function updateResearchItemStatus(id: string, status: string): boolean {
  const result = db.prepare('UPDATE research_items SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id)
  return result.changes > 0
}

export function updateResearchInvestigatedAt(id: string, ts: number): boolean {
  const result = db.prepare('UPDATE research_items SET last_investigated_at = ?, updated_at = ? WHERE id = ?')
    .run(ts, ts, id)
  return result.changes > 0
}

export function deleteResearchItem(id: string): boolean {
  const result = db.prepare('DELETE FROM research_items WHERE id = ?').run(id)
  return result.changes > 0
}

export function getResearchStats(projectId?: string, allowedProjectIds?: string[] | null): { total: number; by_category: Record<string, number>; by_status: Record<string, number>; by_pipeline: Record<string, number> } {
  let pClause: string
  let pParams: unknown[]
  if (projectId) {
    pClause = 'WHERE project_id = ?'
    pParams = [projectId]
  } else if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return { total: 0, by_category: {}, by_status: {}, by_pipeline: {} }
    const ph = allowedProjectIds.map(() => '?').join(', ')
    pClause = `WHERE project_id IN (${ph})`
    pParams = allowedProjectIds
  } else {
    pClause = ''
    pParams = []
  }
  const total = (db.prepare(`SELECT COUNT(*) as c FROM research_items ${pClause}`).get(...pParams) as { c: number }).c
  const catRows = db.prepare(`SELECT category, COUNT(*) as c FROM research_items ${pClause} GROUP BY category`).all(...pParams) as { category: string; c: number }[]
  const statusRows = db.prepare(`SELECT status, COUNT(*) as c FROM research_items ${pClause} GROUP BY status`).all(...pParams) as { status: string; c: number }[]
  const pipeConditions = pClause ? `${pClause} AND pipeline != ''` : `WHERE pipeline != ''`
  const pipeRows = db.prepare(`SELECT pipeline, COUNT(*) as c FROM research_items ${pipeConditions} GROUP BY pipeline`).all(...pParams) as { pipeline: string; c: number }[]

  const by_category: Record<string, number> = {}
  for (const r of catRows) by_category[r.category] = r.c
  const by_status: Record<string, number> = {}
  for (const r of statusRows) by_status[r.status] = r.c
  const by_pipeline: Record<string, number> = {}
  for (const r of pipeRows) by_pipeline[r.pipeline] = r.c

  return { total, by_category, by_status, by_pipeline }
}

// --- Board Query Functions ---

export function createBoardMeeting(m: {
  id: string; date: string; briefing: string;
  metrics_snapshot?: string; agent_highlights?: string; status?: string; project_id?: string
}): void {
  db.prepare(`
    INSERT INTO board_meetings (id, date, briefing, metrics_snapshot, agent_highlights, status, project_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.id, m.date, m.briefing,
    m.metrics_snapshot ?? '{}',
    m.agent_highlights ?? '[]',
    m.status ?? 'draft',
    m.project_id ?? 'default',
    Date.now()
  )
}

export function getLatestBoardMeeting(projectId?: string, allowedProjectIds?: string[] | null): BoardMeeting | null {
  if (projectId) {
    return (db.prepare('SELECT * FROM board_meetings WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId) as BoardMeeting) ?? null
  }
  if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return null
    const ph = allowedProjectIds.map(() => '?').join(', ')
    return (db.prepare(`SELECT * FROM board_meetings WHERE project_id IN (${ph}) ORDER BY created_at DESC LIMIT 1`).get(...allowedProjectIds) as BoardMeeting) ?? null
  }
  return (db.prepare('SELECT * FROM board_meetings ORDER BY created_at DESC LIMIT 1').get() as BoardMeeting) ?? null
}

export function getBoardMeetingHistory(limit: number = 10, projectId?: string, allowedProjectIds?: string[] | null): Array<BoardMeeting & { decision_count: number }> {
  let pClause: string
  let pParams: unknown[]
  if (projectId) {
    pClause = 'WHERE m.project_id = ?'
    pParams = [projectId, limit]
  } else if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return []
    const ph = allowedProjectIds.map(() => '?').join(', ')
    pClause = `WHERE m.project_id IN (${ph})`
    pParams = [...allowedProjectIds, limit]
  } else {
    pClause = ''
    pParams = [limit]
  }
  return db.prepare(`
    SELECT m.*, COALESCE(d.cnt, 0) as decision_count
    FROM board_meetings m
    LEFT JOIN (SELECT meeting_id, COUNT(*) as cnt FROM board_decisions GROUP BY meeting_id) d
      ON d.meeting_id = m.id
    ${pClause}
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(...pParams) as Array<BoardMeeting & { decision_count: number }>
}

export function getBoardMeeting(id: string): (BoardMeeting & { decisions: BoardDecision[] }) | null {
  const meeting = db.prepare('SELECT * FROM board_meetings WHERE id = ?').get(id) as BoardMeeting | undefined
  if (!meeting) return null
  const decisions = db.prepare('SELECT * FROM board_decisions WHERE meeting_id = ? ORDER BY created_at').all(id) as BoardDecision[]
  return { ...meeting, decisions }
}

export function createBoardDecision(d: {
  id: string; meeting_id: string; description: string; status?: string; project_id?: string
}): void {
  // If project_id not provided, inherit from the parent meeting
  const pid = d.project_id ?? (
    (db.prepare('SELECT project_id FROM board_meetings WHERE id = ?').get(d.meeting_id) as { project_id: string } | undefined)?.project_id ?? 'default'
  )
  db.prepare(`
    INSERT INTO board_decisions (id, meeting_id, description, status, project_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(d.id, d.meeting_id, d.description, d.status ?? 'open', pid, Date.now())
}

export function getBoardDecisions(status?: string, projectId?: string, allowedProjectIds?: string[] | null): BoardDecision[] {
  const conditions: string[] = []
  const params: unknown[] = []
  if (status) { conditions.push('status = ?'); params.push(status) }
  if (projectId) {
    conditions.push('project_id = ?'); params.push(projectId)
  } else if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return []
    const ph = allowedProjectIds.map(() => '?').join(', ')
    conditions.push(`project_id IN (${ph})`)
    params.push(...allowedProjectIds)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return db.prepare(`SELECT * FROM board_decisions ${where} ORDER BY created_at DESC`).all(...params) as BoardDecision[]
}

export function updateBoardDecisionStatus(id: string, status: string): boolean {
  const resolvedAt = status === 'resolved' ? Date.now() : null
  const result = db.prepare(
    'UPDATE board_decisions SET status = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?'
  ).run(status, resolvedAt, id)
  return result.changes > 0
}

export function getBoardStats(projectId?: string, allowedProjectIds?: string[] | null): { total_meetings: number; open_decisions: number } {
  let pClause: string
  let pParams: unknown[]
  if (projectId) {
    pClause = ' WHERE project_id = ?'
    pParams = [projectId]
  } else if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return { total_meetings: 0, open_decisions: 0 }
    const ph = allowedProjectIds.map(() => '?').join(', ')
    pClause = ` WHERE project_id IN (${ph})`
    pParams = allowedProjectIds
  } else {
    pClause = ''
    pParams = []
  }
  const meetings = (db.prepare(`SELECT COUNT(*) as c FROM board_meetings${pClause}`).get(...pParams) as { c: number }).c
  const openConditions = pClause ? `WHERE status = 'open'${pClause.replace(' WHERE ', ' AND ')}` : `WHERE status = 'open'`
  const open = (db.prepare(`SELECT COUNT(*) as c FROM board_decisions ${openConditions}`).get(...pParams) as { c: number }).c
  return { total_meetings: meetings, open_decisions: open }
}

// --- Project Overview (All Projects dashboard) ---

export interface ProjectOverviewItem {
  id: string
  display_name: string
  icon: string | null
  primary_color: string | null
  open_findings: number
  active_tasks: number
  research_items: number
  last_feed_at: number | null
  agent_count: number
  recent_activity_24h: number
}

export function getProjectOverview(
  allowedProjectIds?: string[] | null,
): { projects: ProjectOverviewItem[]; totals: { open_findings: number; active_tasks: number; research_total: number } } {
  const bdb = getBotDb()
  if (!bdb) return { projects: [], totals: { open_findings: 0, active_tasks: 0, research_total: 0 } }

  // Scope: null/undefined = admin (no filter), [] = no access (empty), string[] = IN.
  if (Array.isArray(allowedProjectIds) && allowedProjectIds.length === 0) {
    return { projects: [], totals: { open_findings: 0, active_tasks: 0, research_total: 0 } }
  }

  const whereClause = Array.isArray(allowedProjectIds)
    ? `WHERE p.id IN (${allowedProjectIds.map(() => '?').join(', ')})`
    : ''
  const scopeParams: string[] = Array.isArray(allowedProjectIds) ? allowedProjectIds : []

  const projects = bdb.prepare(`
    SELECT p.id, p.display_name, p.icon, ps.primary_color
    FROM projects p
    LEFT JOIN project_settings ps ON ps.project_id = p.id
    ${whereClause}
    ORDER BY p.created_at ASC
  `).all(...scopeParams) as Array<{ id: string; display_name: string; icon: string | null; primary_color: string | null }>

  const result: ProjectOverviewItem[] = []
  let totalFindings = 0
  let totalTasks = 0
  let totalResearch = 0

  for (const p of projects) {
    const findings = (db.prepare("SELECT COUNT(*) as c FROM security_findings WHERE status = 'open' AND project_id = ?").get(p.id) as { c: number }).c
    const tasks = (db.prepare("SELECT COUNT(*) as c FROM scheduled_tasks WHERE status = 'active' AND project_id = ?").get(p.id) as { c: number }).c
    const research = (db.prepare("SELECT COUNT(*) as c FROM research_items WHERE project_id = ?").get(p.id) as { c: number }).c
    const lastFeed = (db.prepare('SELECT MAX(created_at) as t FROM feed WHERE project_id = ?').get(p.id) as { t: number | null }).t
    const agents = (db.prepare('SELECT COUNT(*) as c FROM agents WHERE project_id = ?').get(p.id) as { c: number }).c
    const recentFeedCount = (db.prepare('SELECT COUNT(*) as c FROM feed WHERE project_id = ? AND created_at > ?').get(p.id, Date.now() - 86400000) as { c: number }).c

    totalFindings += findings
    totalTasks += tasks
    totalResearch += research

    result.push({
      id: p.id, display_name: p.display_name, icon: p.icon, primary_color: p.primary_color,
      open_findings: findings, active_tasks: tasks, research_items: research, last_feed_at: lastFeed,
      agent_count: agents, recent_activity_24h: recentFeedCount,
    })
  }

  return { projects: result, totals: { open_findings: totalFindings, active_tasks: totalTasks, research_total: totalResearch } }
}

// --- Projects ---

export interface Project {
  id: string
  name: string
  slug: string
  display_name: string
  icon: string | null
  status: 'active' | 'paused' | 'archived'
  created_at: number
  updated_at: number
  paused_at: number | null
  archived_at: number | null
  auto_archive_days: number | null
}

export interface ProjectSettings {
  project_id: string
  theme_id: string | null
  primary_color: string | null
  accent_color: string | null
  sidebar_color: string | null
  logo_path: string | null
  execution_provider: string | null
  execution_provider_secondary: string | null
  execution_provider_fallback: string | null
  execution_model: string | null
  execution_model_primary: string | null
  execution_model_secondary: string | null
  execution_model_fallback: string | null
  fallback_policy: string | null
  model_tier: string | null
  monthly_cost_cap_usd: number | null
  daily_cost_cap_usd: number | null
}

export function getAllProjects(): Project[] {
  const bdb = getBotDb()
  if (!bdb) return []
  autoArchiveProjectsInDb()
  return bdb.prepare(`
    SELECT *
    FROM projects
    ORDER BY
      CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
      display_name COLLATE NOCASE ASC
  `).all() as Project[]
}

export function getProjectById(id: string): Project | undefined {
  const bdb = getBotDb()
  if (!bdb) return undefined
  autoArchiveProjectsInDb()
  return bdb.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined
}

export function getProjectSettingsById(projectId: string): ProjectSettings | undefined {
  const bdb = getBotDb()
  if (!bdb) return undefined
  return bdb.prepare('SELECT * FROM project_settings WHERE project_id = ?').get(projectId) as ProjectSettings | undefined
}

export function getAllProjectsWithSettings(): Array<Project & Partial<ProjectSettings>> {
  const bdb = getBotDb()
  if (!bdb) return []
  autoArchiveProjectsInDb()
  return bdb.prepare(`
    SELECT p.*, ps.theme_id, ps.primary_color, ps.accent_color, ps.sidebar_color, ps.logo_path,
           ps.execution_provider, ps.execution_provider_secondary, ps.execution_provider_fallback, ps.execution_model,
           ps.execution_model_primary, ps.execution_model_secondary, ps.execution_model_fallback,
           ps.fallback_policy, ps.model_tier
    FROM projects p
    LEFT JOIN project_settings ps ON ps.project_id = p.id
    ORDER BY
      CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
      p.display_name COLLATE NOCASE ASC
  `).all() as Array<Project & Partial<ProjectSettings>>
}

export function createProjectInDb(input: {
  id: string
  name: string
  slug: string
  display_name: string
  icon?: string
  status?: 'active' | 'paused' | 'archived'
  auto_archive_days?: number | null
}): void {
  const bdb = getBotDbWrite()
  if (!bdb) throw new Error('Bot database not available')
  const now = Date.now()
  bdb.prepare(
    `INSERT INTO projects (
      id, name, slug, display_name, icon, status, auto_archive_days, created_at, updated_at, paused_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.name,
    input.slug,
    input.display_name,
    input.icon ?? null,
    input.status ?? 'active',
    input.auto_archive_days ?? null,
    now,
    now,
    input.status === 'paused' ? now : null,
    input.status === 'archived' ? now : null,
  )
}

export function updateProjectInDb(id: string, updates: Record<string, unknown>): void {
  const bdb = getBotDbWrite()
  if (!bdb) throw new Error('Bot database not available')
  const fields: string[] = []
  const values: unknown[] = []
  const now = Date.now()
  for (const [key, val] of Object.entries(updates)) {
    if (['name', 'slug', 'display_name', 'icon', 'status', 'auto_archive_days'].includes(key)) {
      fields.push(`${key} = ?`)
      values.push(val)
    }
  }
  if ('status' in updates) {
    const status = updates.status as string
    if (status === 'paused') {
      fields.push('paused_at = ?')
      values.push(now)
      fields.push('archived_at = NULL')
    } else if (status === 'archived') {
      fields.push('archived_at = ?')
      values.push(now)
      fields.push('paused_at = NULL')
    } else if (status === 'active') {
      fields.push('paused_at = NULL')
      fields.push('archived_at = NULL')
    }
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  values.push(now)
  values.push(id)
  bdb.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteProjectFromDb(id: string): boolean {
  if (id === 'default') return false // never delete default (personal assistant project)
  const bdb = getBotDbWrite()
  if (!bdb) return false
  const exists = bdb.prepare('SELECT 1 FROM projects WHERE id = ?').get(id) as { 1: number } | undefined
  if (!exists) return false

  // Cascade delete in a transaction to avoid orphaned rows
  const tx = bdb.transaction(() => {
    // Bot DB tables with project_id
    for (const table of ['agents', 'messages', 'webhooks', 'project_integrations', 'project_credentials', 'project_settings', 'action_items', 'action_item_events', 'action_item_comments', 'channel_log']) {
      try { bdb.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id) } catch { /* table may not exist */ }
    }
    bdb.prepare('DELETE FROM projects WHERE id = ?').run(id)
  })

  tx() // commit bot DB first

  // Telemetry DB tables with project_id
  try {
    for (const table of [
      'research_items', 'board_meetings', 'board_decisions', 'security_score_history', 'security_findings',
      'security_scans', 'feed', 'scheduled_tasks', 'metrics', 'security_auto_fixes', 'project_integrations',
      'paws', 'paw_cycles', 'metric_health', 'action_item_chat_messages', 'research_chat_messages',
    ]) {
      try { db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id) } catch { /* table may not exist */ }
    }
  } catch (err) {
    logger.warn({ err }, 'telemetry cleanup partial failure')
  }

  return true
}

export function upsertProjectSettingsInDb(input: {
  project_id: string
  theme_id?: string
  primary_color?: string
  accent_color?: string
  sidebar_color?: string
  logo_path?: string
  execution_provider?: string
  execution_provider_secondary?: string
  execution_provider_fallback?: string
  execution_model?: string
  execution_model_primary?: string
  execution_model_secondary?: string
  execution_model_fallback?: string
  fallback_policy?: string
  model_tier?: string
  monthly_cost_cap_usd?: number | null
  daily_cost_cap_usd?: number | null
}): void {
  const bdb = getBotDbWrite()
  if (!bdb) throw new Error('Bot database not available')
  const keys = Object.keys(input).filter((key) => key !== 'project_id')
  if (keys.length === 0) {
    bdb.prepare(`INSERT INTO project_settings (project_id) VALUES (?) ON CONFLICT(project_id) DO NOTHING`).run(input.project_id)
    return
  }

  const columns = ['project_id', ...keys]
  const placeholders = columns.map(() => '?').join(', ')
  const updates = keys.map((key) => `${key} = excluded.${key}`).join(', ')
  const values = columns.map((key) => (input as Record<string, unknown>)[key] ?? null)

  bdb.prepare(`
    INSERT INTO project_settings (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(project_id) DO UPDATE SET ${updates}
  `).run(...values)
}

function latestProjectTimestamp(dbh: Database.Database, table: string, projectId: string, column: string = 'created_at'): number | null {
  try {
    const row = dbh.prepare(`SELECT MAX(${column}) as ts FROM ${table} WHERE project_id = ?`).get(projectId) as { ts: number | null }
    return row?.ts ?? null
  } catch {
    return null
  }
}

function getProjectLastActivityAt(project: Project): number {
  const bdb = getBotDb()
  const timestamps = [project.updated_at || project.created_at, project.created_at]

  if (bdb) {
    const botTables: Array<[string, string]> = [
      ['messages', 'created_at'],
      ['channel_log', 'created_at'],
      ['action_items', 'updated_at'],
    ]
    for (const [table, column] of botTables) {
      const ts = latestProjectTimestamp(bdb, table, project.id, column)
      if (ts) timestamps.push(ts)
    }
  }

  if (db) {
    const telemetryTables: Array<[string, string]> = [
      ['feed', 'created_at'],
      ['research_items', 'created_at'],
      ['board_meetings', 'created_at'],
      ['scheduled_tasks', 'last_run'],
      ['metrics', 'recorded_at'],
      ['security_findings', 'last_seen'],
    ]
    for (const [table, column] of telemetryTables) {
      const ts = latestProjectTimestamp(db, table, project.id, column)
      if (ts) timestamps.push(ts)
    }
  }

  return Math.max(...timestamps.filter((ts): ts is number => typeof ts === 'number' && Number.isFinite(ts)))
}

export function autoArchiveProjectsInDb(now: number = Date.now()): number {
  const bdb = getBotDbWrite()
  if (!bdb) return 0

  const projects = bdb.prepare(`
    SELECT *
    FROM projects
    WHERE status = 'active'
      AND auto_archive_days IS NOT NULL
      AND auto_archive_days > 0
  `).all() as Project[]

  let archived = 0
  for (const project of projects) {
    const cutoff = now - (project.auto_archive_days as number) * 24 * 60 * 60 * 1000
    const lastActivity = getProjectLastActivityAt(project)
    if (lastActivity <= cutoff) {
      const result = bdb.prepare(`
        UPDATE projects
        SET status = 'archived', archived_at = ?, paused_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'active'
      `).run(now, now, project.id)
      archived += result.changes
    }
  }
  return archived
}

// --- Comms (inter-agent communication queries) ---

export interface CommsFilter {
  agent?: string
  type?: string
  sinceMs?: number
  project_id?: string
  allowedProjectIds?: string[] | null
  limit?: number
}

export function getCommsLog(filter: CommsFilter): { messages: any[]; total: number } {
  const conditions: string[] = []
  const params: any[] = []

  if (filter.agent) {
    conditions.push('(m.from_agent = ? OR m.to_agent = ?)')
    params.push(filter.agent, filter.agent)
  }
  if (filter.type) {
    conditions.push('m.type = ?')
    params.push(filter.type)
  }
  if (filter.sinceMs) {
    conditions.push('m.created_at > ?')
    params.push(filter.sinceMs)
  }
  if (filter.project_id) {
    conditions.push('m.project_id = ?')
    params.push(filter.project_id)
  } else if (Array.isArray(filter.allowedProjectIds)) {
    if (filter.allowedProjectIds.length === 0) return { messages: [], total: 0 }
    const ph = filter.allowedProjectIds.map(() => '?').join(', ')
    conditions.push(`m.project_id IN (${ph})`)
    params.push(...filter.allowedProjectIds)
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const limit = Math.min(filter.limit || 50, 200)

  const total = (db.prepare(
    `SELECT COUNT(*) as c FROM messages m ${where}`
  ).get(...params) as { c: number }).c

  const messages = db.prepare(`
    SELECT m.id, m.from_agent as "from", m.to_agent as "to", m.content, m.type, m.status, m.created_at
    FROM messages m
    ${where}
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(...params, limit) as any[]

  return { messages, total }
}

export function getActiveConnections(sinceMs: number, projectId?: string, allowedProjectIds?: string[] | null): { connections: any[] } {
  if (projectId) {
    const connections = db.prepare(`
      SELECT from_agent as "from", to_agent as "to", COUNT(*) as count, MAX(created_at) as last_active
      FROM messages
      WHERE created_at > ? AND project_id = ?
      GROUP BY from_agent, to_agent
      ORDER BY last_active DESC
    `).all(sinceMs, projectId) as any[]
    return { connections }
  }
  if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return { connections: [] }
    const ph = allowedProjectIds.map(() => '?').join(', ')
    const connections = db.prepare(`
      SELECT from_agent as "from", to_agent as "to", COUNT(*) as count, MAX(created_at) as last_active
      FROM messages
      WHERE created_at > ? AND project_id IN (${ph})
      GROUP BY from_agent, to_agent
      ORDER BY last_active DESC
    `).all(sinceMs, ...allowedProjectIds) as any[]
    return { connections }
  }
  const connections = db.prepare(`
    SELECT from_agent as "from", to_agent as "to", COUNT(*) as count, MAX(created_at) as last_active
    FROM messages
    WHERE created_at > ?
    GROUP BY from_agent, to_agent
    ORDER BY last_active DESC
  `).all(sinceMs) as any[]

  return { connections }
}

// --- Plugins ---

export interface PluginRow {
  id: string
  name: string
  version: string
  author: string
  description: string
  keywords: string
  agent_id: string | null
  dependencies: string
  enabled: number
  installed_at: number
}

export function getAllPlugins(): PluginRow[] {
  return db.prepare('SELECT * FROM plugins ORDER BY name').all() as PluginRow[]
}

export function getPluginById(id: string): PluginRow | undefined {
  return db.prepare('SELECT * FROM plugins WHERE id = ?').get(id) as PluginRow | undefined
}

export function upsertPlugin(p: {
  id: string; name: string; version: string; author: string; description: string;
  keywords: string[]; agent_id?: string; dependencies?: string[]; enabled?: boolean
}): void {
  db.prepare(`
    INSERT INTO plugins (id, name, version, author, description, keywords, agent_id, dependencies, enabled, installed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      version = excluded.version,
      author = excluded.author,
      description = excluded.description,
      keywords = excluded.keywords,
      agent_id = excluded.agent_id,
      dependencies = excluded.dependencies
  `).run(
    p.id, p.name, p.version, p.author, p.description,
    JSON.stringify(p.keywords ?? []),
    p.agent_id ?? null,
    JSON.stringify(p.dependencies ?? []),
    p.enabled !== false ? 1 : 0,
    Date.now(),
  )
}

export function updatePluginEnabled(id: string, enabled: boolean): boolean {
  const result = db.prepare('UPDATE plugins SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  return result.changes > 0
}

export function deletePlugin(id: string): boolean {
  const result = db.prepare('DELETE FROM plugins WHERE id = ?').run(id)
  return result.changes > 0
}

// --- Webhooks (reads from bot DB) ---

export interface WebhookRow {
  id: string
  project_id: string
  event_type: string
  target_url: string
  secret: string
  active: number
  created_at: number
}

export interface WebhookDeliveryRow {
  id: string
  webhook_id: string
  event_type: string
  payload: string
  status_code: number | null
  response_time_ms: number | null
  error: string | null
  created_at: number
}

export function getAllWebhooks(projectId?: string, allowedProjectIds?: string[] | null): WebhookRow[] {
  const botDb = getBotDb()
  if (!botDb) return []
  try {
    if (projectId) {
      return botDb.prepare('SELECT * FROM webhooks WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as WebhookRow[]
    }
    if (Array.isArray(allowedProjectIds)) {
      if (allowedProjectIds.length === 0) return []
      const ph = allowedProjectIds.map(() => '?').join(', ')
      return botDb.prepare(`SELECT * FROM webhooks WHERE project_id IN (${ph}) ORDER BY created_at DESC`).all(...allowedProjectIds) as WebhookRow[]
    }
    return botDb.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as WebhookRow[]
  } catch { return [] }
}

export function createWebhookInBotDb(webhook: WebhookRow): boolean {
  const botDb = getBotDbWrite()
  if (!botDb) return false
  try {
    botDb.prepare(`
      INSERT INTO webhooks (id, project_id, event_type, target_url, secret, active, created_at)
      VALUES (@id, @project_id, @event_type, @target_url, @secret, @active, @created_at)
    `).run(webhook)
    return true
  } catch (err) {
    logger.error({ err }, 'Failed to create webhook in bot DB')
    return false
  }
}

export function deleteWebhookFromBotDb(id: string): boolean {
  const botDb = getBotDbWrite()
  if (!botDb) return false
  try {
    const result = botDb.prepare('DELETE FROM webhooks WHERE id = ?').run(id)
    return result.changes > 0
  } catch { return false }
}

export function toggleWebhookInBotDb(id: string, active: boolean): boolean {
  const botDb = getBotDbWrite()
  if (!botDb) return false
  try {
    const result = botDb.prepare('UPDATE webhooks SET active = ? WHERE id = ?').run(active ? 1 : 0, id)
    return result.changes > 0
  } catch { return false }
}

export function getRecentWebhookDeliveries(limit = 50, projectId?: string, allowedProjectIds?: string[] | null): WebhookDeliveryRow[] {
  const botDb = getBotDb()
  if (!botDb) return []
  try {
    if (projectId) {
      return botDb.prepare(
        `SELECT wd.* FROM webhook_deliveries wd
         JOIN webhooks w ON wd.webhook_id = w.id
         WHERE w.project_id = ?
         ORDER BY wd.created_at DESC LIMIT ?`
      ).all(projectId, limit) as WebhookDeliveryRow[]
    }
    if (Array.isArray(allowedProjectIds)) {
      if (allowedProjectIds.length === 0) return []
      const ph = allowedProjectIds.map(() => '?').join(', ')
      return botDb.prepare(
        `SELECT wd.* FROM webhook_deliveries wd
         JOIN webhooks w ON wd.webhook_id = w.id
         WHERE w.project_id IN (${ph})
         ORDER BY wd.created_at DESC LIMIT ?`
      ).all(...allowedProjectIds, limit) as WebhookDeliveryRow[]
    }
    return botDb.prepare('SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?').all(limit) as WebhookDeliveryRow[]
  } catch { return [] }
}
// --- Project Integrations ---

export interface ProjectIntegration {
  id: number
  project_id: string
  platform: string
  display_name: string
  handle: string | null
  metric_prefix: string | null
  config: string
  sort_order: number
  enabled: number
  created_at: number
}

export function getProjectIntegrations(projectId: string): ProjectIntegration[] {
  return db.prepare('SELECT * FROM project_integrations WHERE project_id = ? AND enabled = 1 ORDER BY sort_order, id').all(projectId) as ProjectIntegration[]
}

export function getAllProjectIntegrations(allowedProjectIds?: string[] | null): ProjectIntegration[] {
  // Admins: allowedProjectIds === null -> no filter.
  // Members with no access: empty array -> return []. Otherwise restrict by IN.
  if (allowedProjectIds === null || allowedProjectIds === undefined) {
    return db.prepare('SELECT * FROM project_integrations WHERE enabled = 1 ORDER BY project_id, sort_order, id').all() as ProjectIntegration[]
  }
  if (allowedProjectIds.length === 0) return []
  const placeholders = allowedProjectIds.map(() => '?').join(', ')
  return db.prepare(
    `SELECT * FROM project_integrations WHERE enabled = 1 AND project_id IN (${placeholders}) ORDER BY project_id, sort_order, id`,
  ).all(...allowedProjectIds) as ProjectIntegration[]
}

export function upsertProjectIntegration(data: Omit<ProjectIntegration, 'id'>): void {
  db.prepare(`
    INSERT INTO project_integrations (project_id, platform, display_name, handle, metric_prefix, config, sort_order, enabled, created_at)
    VALUES (@project_id, @platform, @display_name, @handle, @metric_prefix, @config, @sort_order, @enabled, @created_at)
    ON CONFLICT(project_id, platform, handle) DO UPDATE SET
      display_name = excluded.display_name,
      metric_prefix = excluded.metric_prefix,
      config = excluded.config,
      sort_order = excluded.sort_order,
      enabled = excluded.enabled
  `).run(data)
}

export function deleteProjectIntegration(id: number): boolean {
  return db.prepare('DELETE FROM project_integrations WHERE id = ?').run(id).changes > 0
}

// --- Metric Health (self-healing) ---

export type MetricHealthStatus = 'healthy' | 'degraded' | 'failing' | 'unsupported'

export interface MetricHealth {
  integration_id: number
  project_id: string
  platform: string
  metric_prefix: string
  status: MetricHealthStatus
  last_check: number
  last_success: number | null
  attempts: number
  reason: string | null
  missing_keys: string | null
}

export function upsertMetricHealth(row: {
  integration_id: number
  project_id: string
  platform: string
  metric_prefix: string
  status: MetricHealthStatus
  reason?: string | null
  missing_keys?: string[] | null
}): void {
  const now = Date.now()
  const existing = db
    .prepare('SELECT attempts, last_success FROM metric_health WHERE integration_id = ?')
    .get(row.integration_id) as { attempts: number; last_success: number | null } | undefined

  const attempts = row.status === 'healthy' ? 0 : (existing?.attempts ?? 0) + 1
  const lastSuccess = row.status === 'healthy' ? now : (existing?.last_success ?? null)
  const missingJson = row.missing_keys && row.missing_keys.length > 0 ? JSON.stringify(row.missing_keys) : null

  db.prepare(`
    INSERT INTO metric_health (integration_id, project_id, platform, metric_prefix, status, last_check, last_success, attempts, reason, missing_keys)
    VALUES (@integration_id, @project_id, @platform, @metric_prefix, @status, @last_check, @last_success, @attempts, @reason, @missing_keys)
    ON CONFLICT(integration_id) DO UPDATE SET
      project_id    = excluded.project_id,
      platform      = excluded.platform,
      metric_prefix = excluded.metric_prefix,
      status        = excluded.status,
      last_check    = excluded.last_check,
      last_success  = excluded.last_success,
      attempts      = excluded.attempts,
      reason        = excluded.reason,
      missing_keys  = excluded.missing_keys
  `).run({
    integration_id: row.integration_id,
    project_id:     row.project_id,
    platform:       row.platform,
    metric_prefix:  row.metric_prefix,
    status:         row.status,
    last_check:     now,
    last_success:   lastSuccess,
    attempts,
    reason:         row.reason ?? null,
    missing_keys:   missingJson,
  })
}

export function getMetricHealthForProject(projectId?: string, allowedProjectIds?: string[] | null): MetricHealth[] {
  if (projectId) {
    return db.prepare('SELECT * FROM metric_health WHERE project_id = ? ORDER BY platform').all(projectId) as MetricHealth[]
  }
  if (Array.isArray(allowedProjectIds)) {
    if (allowedProjectIds.length === 0) return []
    const ph = allowedProjectIds.map(() => '?').join(', ')
    return db.prepare(`SELECT * FROM metric_health WHERE project_id IN (${ph}) ORDER BY project_id, platform`).all(...allowedProjectIds) as MetricHealth[]
  }
  return db.prepare('SELECT * FROM metric_health ORDER BY project_id, platform').all() as MetricHealth[]
}

export function getDegradedMetricHealth(): MetricHealth[] {
  return db
    .prepare("SELECT * FROM metric_health WHERE status IN ('degraded','failing') ORDER BY attempts DESC, last_check ASC")
    .all() as MetricHealth[]
}

// --- Channel Log ---

export function insertChannelLog(entry: Record<string, unknown>): void {
  try {
    db.prepare(
      `INSERT INTO channel_log (direction, channel, channel_name, bot_name, project_id, chat_id, sender_name, agent_id, content, content_type, is_voice, is_group, duration_ms, tokens_used, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.direction ?? 'in',
      entry.channel ?? entry.channelId ?? '',
      entry.channelName ?? entry.channel_name ?? '',
      entry.botName ?? entry.bot_name ?? '',
      entry.projectId ?? entry.project_id ?? 'default',
      entry.chatId ?? entry.chat_id ?? '',
      entry.senderName ?? entry.sender_name ?? '',
      entry.agentId ?? entry.agent_id ?? '',
      entry.content ?? '',
      entry.contentType ?? entry.content_type ?? 'text',
      (entry.isVoice ?? entry.is_voice ?? false) ? 1 : 0,
      (entry.isGroup ?? entry.is_group ?? false) ? 1 : 0,
      entry.durationMs ?? entry.duration_ms ?? null,
      entry.tokensUsed ?? entry.tokens_used ?? null,
      entry.error ?? null,
      entry.createdAt ?? entry.created_at ?? Date.now(),
    )
  } catch (err) {
    logger.error({ err }, 'Failed to insert channel_log entry')
  }
}

export function getChannelLog(filter: {
  project_id?: string
  allowedProjectIds?: string[] | null
  channel?: string
  bot_name?: string
  direction?: string
  search?: string
  sinceMs?: number
  limit?: number
  offset?: number
}): { entries: any[]; total: number } {
  const conditions: string[] = []
  const params: any[] = []

  if (filter.project_id) {
    conditions.push('project_id = ?')
    params.push(filter.project_id)
  } else if (Array.isArray(filter.allowedProjectIds)) {
    if (filter.allowedProjectIds.length === 0) return { entries: [], total: 0 }
    const ph = filter.allowedProjectIds.map(() => '?').join(', ')
    conditions.push(`project_id IN (${ph})`)
    params.push(...filter.allowedProjectIds)
  }
  if (filter.channel) {
    conditions.push('channel LIKE ?')
    params.push(filter.channel + '%')
  }
  if (filter.bot_name) {
    conditions.push('bot_name = ?')
    params.push(filter.bot_name)
  }
  if (filter.direction) {
    conditions.push('direction = ?')
    params.push(filter.direction)
  }
  if (filter.search) {
    conditions.push('content LIKE ?')
    params.push('%' + filter.search + '%')
  }
  if (filter.sinceMs) {
    conditions.push('created_at > ?')
    params.push(filter.sinceMs)
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''
  const limit = Math.min(filter.limit || 50, 200)
  const offset = filter.offset || 0

  const entries = db.prepare(
    'SELECT * FROM channel_log ' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(...params, limit, offset) as any[]

  const countRow = db.prepare(
    'SELECT COUNT(*) as c FROM channel_log ' + where
  ).get(...params) as { c: number }

  return { entries, total: countRow.c }
}

// --- Credential Store (mirrors src/credentials.ts but operates on the bot DB) ---

const CRED_ALGORITHM = 'aes-256-gcm'
const CRED_IV_LENGTH = 12

function getCredEncryptionKey(): Buffer | null {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!hex || hex.length !== 64) return null
  return Buffer.from(hex, 'hex')
}

function credEncrypt(plaintext: string): { value: Buffer; iv: Buffer; tag: Buffer } {
  const key = getCredEncryptionKey()
  if (!key) throw new Error('CREDENTIAL_ENCRYPTION_KEY not set or invalid')
  const iv = randomBytes(CRED_IV_LENGTH)
  const cipher = createCipheriv(CRED_ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { value: encrypted, iv, tag: cipher.getAuthTag() }
}

function credDecrypt(value: Buffer, iv: Buffer, tag: Buffer): string {
  const key = getCredEncryptionKey()
  if (!key) throw new Error('CREDENTIAL_ENCRYPTION_KEY not set or invalid')
  const decipher = createDecipheriv(CRED_ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(value), decipher.final()]).toString('utf8')
}

export function credDecryptForVerify(value: Buffer, iv: Buffer, tag: Buffer): string {
  return credDecrypt(value, iv, tag)
}

export function setOAuthCredential(projectId: string, service: string, key: string, plaintext: string): void {
  const bdb = getBotDbWrite()
  if (!bdb) throw new Error('Bot DB not available')
  const { value, iv, tag } = credEncrypt(plaintext)
  const now = Date.now()
  bdb.prepare(`
    INSERT INTO project_credentials (project_id, service, key, value, iv, tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, service, key) DO UPDATE SET
      value = excluded.value, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at
  `).run(projectId, service, key, value, iv, tag, now, now)
}

export function getOAuthServiceCredentials(projectId: string, service: string): Record<string, string> {
  const bdb = getBotDb()
  if (!bdb) return {}
  const rows = bdb.prepare(
    'SELECT key, value, iv, tag FROM project_credentials WHERE project_id = ? AND service = ?'
  ).all(projectId, service) as Array<{ key: string; value: Buffer; iv: Buffer; tag: Buffer }>
  const result: Record<string, string> = {}
  for (const row of rows) {
    try { result[row.key] = credDecrypt(row.value, row.iv, row.tag) } catch { /* skip */ }
  }
  return result
}

export function listOAuthServices(projectId: string): string[] {
  const bdb = getBotDb()
  if (!bdb) return []
  const rows = bdb.prepare(
    'SELECT DISTINCT service FROM project_credentials WHERE project_id = ?'
  ).all(projectId) as Array<{ service: string }>
  return rows.map(r => r.service)
}

export function deleteOAuthService(projectId: string, service: string): void {
  const bdb = getBotDbWrite()
  if (!bdb) return
  bdb.prepare('DELETE FROM project_credentials WHERE project_id = ? AND service = ?').run(projectId, service)
}

// --- Dashboard Credential Management (write-only, no value exposure) ---

export function listProjectCredentials(projectId: string): Array<{
  service: string
  keys: Array<{ key: string; updated_at: number }>
}> {
  const bdb = getBotDb()
  if (!bdb) return []
  const rows = bdb.prepare(
    'SELECT service, key, updated_at FROM project_credentials WHERE project_id = ? ORDER BY service, key'
  ).all(projectId) as Array<{ service: string; key: string; updated_at: number }>
  const grouped = new Map<string, Array<{ key: string; updated_at: number }>>()
  for (const row of rows) {
    if (!grouped.has(row.service)) grouped.set(row.service, [])
    grouped.get(row.service)!.push({ key: row.key, updated_at: row.updated_at })
  }
  return Array.from(grouped.entries()).map(([service, keys]) => ({ service, keys }))
}

export function listAllProjectCredentials(): Array<{
  project_id: string
  service: string
  keys: Array<{ key: string; updated_at: number }>
}> {
  const bdb = getBotDb()
  if (!bdb) return []
  const rows = bdb.prepare(
    'SELECT project_id, service, key, updated_at FROM project_credentials ORDER BY project_id, service, key'
  ).all() as Array<{ project_id: string; service: string; key: string; updated_at: number }>
  const grouped = new Map<string, Array<{ key: string; updated_at: number }>>()
  const projectMap = new Map<string, string>()
  for (const row of rows) {
    const compositeKey = row.project_id + '::' + row.service
    if (!grouped.has(compositeKey)) { grouped.set(compositeKey, []); projectMap.set(compositeKey, row.project_id) }
    grouped.get(compositeKey)!.push({ key: row.key, updated_at: row.updated_at })
  }
  return Array.from(grouped.entries()).map(([compositeKey, keys]) => ({
    project_id: projectMap.get(compositeKey)!,
    service: compositeKey.split('::')[1],
    keys,
  }))
}

export function listAllProjectCredentialValues(): Array<{
  project_id: string
  service: string
  key: string
  value: string
  updated_at: number
}> {
  const bdb = getBotDb()
  if (!bdb) return []
  const rows = bdb.prepare(
    'SELECT project_id, service, key, value, iv, tag, updated_at FROM project_credentials ORDER BY project_id, service, key'
  ).all() as Array<{
    project_id: string
    service: string
    key: string
    value: Buffer
    iv: Buffer
    tag: Buffer
    updated_at: number
  }>

  const result: Array<{
    project_id: string
    service: string
    key: string
    value: string
    updated_at: number
  }> = []

  for (const row of rows) {
    try {
      result.push({
        project_id: row.project_id,
        service: row.service,
        key: row.key,
        value: credDecrypt(row.value, row.iv, row.tag),
        updated_at: row.updated_at,
      })
    } catch {
      // Skip unreadable rows during sync backfill instead of failing the whole payload.
    }
  }

  return result
}

export function setProjectCredential(projectId: string, service: string, key: string, value: string): void {
  const bdb = getBotDbWrite()
  if (!bdb) throw new Error('Bot DB not available')
  const { value: encrypted, iv, tag } = credEncrypt(value)
  const now = Date.now()
  bdb.prepare(`
    INSERT INTO project_credentials (project_id, service, key, value, iv, tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, service, key) DO UPDATE SET
      value = excluded.value, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at
  `).run(projectId, service, key, encrypted, iv, tag, now, now)
}

export function deleteProjectCredentialKey(projectId: string, service: string, key: string): void {
  const bdb = getBotDbWrite()
  if (!bdb) return
  bdb.prepare(
    'DELETE FROM project_credentials WHERE project_id = ? AND service = ? AND key = ?'
  ).run(projectId, service, key)
}

export function deleteProjectCredentialService(projectId: string, service: string): void {
  const bdb = getBotDbWrite()
  if (!bdb) return
  bdb.prepare(
    'DELETE FROM project_credentials WHERE project_id = ? AND service = ?'
  ).run(projectId, service)
}

export function closeAllDatabases(): void {
  try { db?.close() } catch (err) { logger.debug({ err }, 'database close error (possibly already closed): main') }
  try { botDbWrite?.close() } catch (err) { logger.debug({ err }, 'database close error (possibly already closed): bot write') }
  try { botDbReadonly?.close() } catch (err) { logger.debug({ err }, 'database close error (possibly already closed): bot readonly') }
  try { telemetryDb?.close() } catch (err) { logger.debug({ err }, 'database close error (possibly already closed): telemetry') }
}
