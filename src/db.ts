import Database from 'better-sqlite3'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as sqliteVec from 'sqlite-vec'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'
import { initPawsTables } from './paws/db.js'
import { runMigrations } from './migrations.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Session {
  chat_id: string
  session_id: string
  updated_at: number
}

export interface Memory {
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: 'semantic' | 'episodic'
  salience: number
  created_at: number
  accessed_at: number
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
  created_at: number
  project_id: string
}

export interface InteractionFeedback {
  id: string
  chat_id: string
  agent_id: string | null
  user_message: string
  bot_response: string
  feedback_type: 'correction' | 'explicit'
  feedback_note: string | null
  created_at: number
  consumed: number
}

export interface LearnedPatch {
  id: string
  agent_id: string | null
  feedback_id: string
  content: string
  created_at: number
  expires_at: number
}

export interface LearnedSkill {
  id: number
  uuid: string
  agent_id: string | null
  title: string
  content: string
  source_ids: string
  effectiveness: number
  created_at: number
  last_used: number | null
  status: 'active' | 'retired'
}

export interface Project {
  id: string
  name: string
  slug: string
  display_name: string
  icon: string | null
  created_at: number
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

export type ActionItemStatus =
  | 'proposed'
  | 'approved'
  | 'in_progress'
  | 'blocked'
  | 'paused'
  | 'completed'
  | 'rejected'
  | 'archived'

export type ActionItemPriority = 'low' | 'medium' | 'high' | 'critical'

export interface ActionItem {
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

export interface ActionItemComment {
  id: string
  item_id: string
  author: string
  body: string
  created_at: number
}

export interface ActionItemEvent {
  id: string
  item_id: string
  actor: string
  event_type: 'created' | 'status_changed' | 'assigned' | 'commented' | 'ran' | 'archived' | 'moved'
  old_value: string | null
  new_value: string | null
  created_at: number
}

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------

let db: Database.Database

const TASK_PROMPT_OVERRIDES: Record<string, string> = {
  'fop-weekly-briefing': `You are the Researcher for Example Company. Run the Monday morning briefing.

Use the structured Gmail and calendar context provided in the prompt. Do not claim integrations are missing unless the structured context explicitly reports an error.
Use web research only for FilmFreeway and public festival deadline checks.

Deliver a concise briefing with:
- Important emails needing attention
- Upcoming deadlines/events with dates
- Any outreach responses
- 3-5 action items for the week

Keep it tight and actionable. No fluff.`,
  'fop-weekly-content-plan': `You are the Marketing Lead for Example Company. Draft the weekly content plan.

Use the structured Google Sheets context provided in the prompt. Do not say the spreadsheet is unavailable unless the structured context explicitly reports an error.

Then plan this week's content across:
- Blog post topic for example.com
- Facebook posts
- Instagram posts
- Twitter/X posts
- Newsletter if applicable

For each item include:
- Topic/angle
- Platform
- Suggested day
- Strategic goal tie-back

Content pillars: BTS, festival journey, founders' story, industry insights, SV III on Prime, Example Film development.
If a specific metric tab/range cannot be read, say exactly what succeeded and continue with the best grounded draft.`,
  'fop-weekly-festival-scan': `You are the Festival Strategist for Example Company. Run the weekly festival scan.

Use the structured festival tracker context provided in the prompt to avoid duplicates. Do not say the festival spreadsheet is unavailable unless the structured context explicitly reports an error.
Use web research for FilmFreeway-equivalent discovery and public festival deadline checks.

Produce a curated report of 5-10 upcoming festivals relevant to:
- Example Film (short film, thriller/drama, 15 min)
- Example Project III (short film, horror/thriller, on Amazon Prime)

For each festival include:
- Name and location
- Submission deadline
- Event dates
- Submission fee and category
- Industry presence
- Strategic fit / ROI
- URL

Rank by strategic value, not just prestige, and connect recommendations back to the Example Film feature funding goal.`,
}

// SQLite does not support parameterized PRAGMA arguments, so we interpolate.
// Validate identifiers here to keep hasColumn safe even if a future caller
// passes config-derived or plugin-provided table/column names.
//
// MIRROR: server/src/db.ts has an identical copy. Both are deployed
// independently (bot vs dashboard), so they can't share a module via tsconfig
// rootDir boundaries. Keep both in sync if the grammar ever needs to change.
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

function addColumnIfMissing(dbh: Database.Database, table: string, column: string, def: string): void {
  const cols = dbh.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (cols.some(c => c.name === column)) return
  dbh.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
}

/**
 * Link action_items to research_items by adding a nullable research_item_id column
 * and the supporting index. Idempotent -- safe to call on every boot.
 *
 * Prerequisite: the action_items table must already exist. Callers outside
 * initDatabase should verify that first.
 */
export function ensureActionItemsResearchLink(dbh: Database.Database): void {
  if (!hasColumn(dbh, 'action_items', 'research_item_id')) {
    dbh.exec(`ALTER TABLE action_items ADD COLUMN research_item_id TEXT DEFAULT NULL`)
  }
  dbh.exec(`CREATE INDEX IF NOT EXISTS idx_action_items_research ON action_items(research_item_id)`)
}

function reconcileTaskPromptOverrides(): number {
  const update = db.prepare('UPDATE scheduled_tasks SET prompt = ? WHERE id = ? AND prompt != ?')
  let changed = 0
  const tx = db.transaction(() => {
    for (const [taskId, prompt] of Object.entries(TASK_PROMPT_OVERRIDES)) {
      changed += update.run(prompt, taskId, prompt).changes
    }
  })
  tx()
  return changed
}

export function initDatabase(): Database.Database {
  // DB_PATH env override lets staging runs point at a copy of the prod DB.
  const dbPath = process.env.DB_PATH ?? path.join(STORE_DIR, 'claudepaw.db')
  mkdirSync(path.dirname(dbPath), { recursive: true })
  db = new Database(dbPath)

  // Load sqlite-vec for vector search — graceful if unavailable
  try {
    sqliteVec.load(db)
  } catch (err) {
    logger.warn({ err }, 'sqlite-vec unavailable — vector search disabled')
  }

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id    TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id     TEXT NOT NULL,
      topic_key   TEXT,
      content     TEXT NOT NULL,
      sector      TEXT NOT NULL CHECK(sector IN ('semantic', 'episodic')),
      salience    REAL NOT NULL DEFAULT 1.0,
      created_at  INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='id'
    );

    -- Keep FTS in sync via triggers
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content)
        VALUES (new.id, new.content);
    END;

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      schedule    TEXT NOT NULL,
      next_run    INTEGER NOT NULL,
      last_run    INTEGER,
      last_result TEXT,
      status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused')),
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_next
      ON scheduled_tasks (status, next_run);

    -- Security tables
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

    -- Guard events
    CREATE TABLE IF NOT EXISTS guard_events (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('BLOCKED', 'FLAGGED', 'PASSED')),
      triggered_layers TEXT,
      block_reason TEXT,
      original_message TEXT,
      sanitized_message TEXT,
      layer_results TEXT,
      latency_ms INTEGER,
      request_id TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_guard_events_type ON guard_events(event_type, timestamp);
    CREATE INDEX IF NOT EXISTS idx_guard_events_request ON guard_events(request_id);

    -- Newsletter tables
    CREATE TABLE IF NOT EXISTS newsletter_seen_links (
      url TEXT PRIMARY KEY,
      sent_at INTEGER NOT NULL,
      edition_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS newsletter_editions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      lookback_days INTEGER NOT NULL,
      articles_cyber INTEGER NOT NULL DEFAULT 0,
      articles_ai INTEGER NOT NULL DEFAULT 0,
      articles_research INTEGER NOT NULL DEFAULT 0,
      hero_path TEXT,
      html_bytes INTEGER,
      sent_at INTEGER,
      recipient TEXT NOT NULL
    );

    -- Learning tables
    CREATE TABLE IF NOT EXISTS interaction_feedback (
      id            TEXT PRIMARY KEY,
      chat_id       TEXT NOT NULL,
      agent_id      TEXT,
      user_message  TEXT NOT NULL,
      bot_response  TEXT NOT NULL,
      feedback_type TEXT NOT NULL CHECK(feedback_type IN ('correction', 'explicit')),
      feedback_note TEXT,
      created_at    INTEGER NOT NULL,
      consumed      INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_consumed ON interaction_feedback(consumed);
    CREATE INDEX IF NOT EXISTS idx_feedback_agent ON interaction_feedback(agent_id);

    CREATE TABLE IF NOT EXISTS learned_patches (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT,
      feedback_id   TEXT NOT NULL,
      content       TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_patches_agent_expiry ON learned_patches(agent_id, expires_at);

    CREATE TABLE IF NOT EXISTS learned_skills (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid          TEXT NOT NULL UNIQUE,
      agent_id      TEXT,
      title         TEXT NOT NULL,
      content       TEXT NOT NULL,
      source_ids    TEXT NOT NULL DEFAULT '[]',
      effectiveness REAL NOT NULL DEFAULT 1.0,
      created_at    INTEGER NOT NULL,
      last_used     INTEGER,
      status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'retired'))
    );
    CREATE INDEX IF NOT EXISTS idx_skills_agent_status ON learned_skills(agent_id, status);

    CREATE VIRTUAL TABLE IF NOT EXISTS learned_skills_fts USING fts5(
      content,
      content='learned_skills',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON learned_skills BEGIN
      INSERT INTO learned_skills_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON learned_skills BEGIN
      INSERT INTO learned_skills_fts(learned_skills_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE OF content ON learned_skills BEGIN
      INSERT INTO learned_skills_fts(learned_skills_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      INSERT INTO learned_skills_fts(rowid, content)
        VALUES (new.id, new.content);
    END;

    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      slug         TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      icon         TEXT,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      email        TEXT    NOT NULL UNIQUE,
      name         TEXT    NOT NULL,
      global_role  TEXT    NOT NULL DEFAULT 'member'
                    CHECK (global_role IN ('admin','member','bot')),
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS user_tokens (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   TEXT    NOT NULL UNIQUE,
      label        TEXT    NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_user_tokens_hash ON user_tokens(token_hash) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens(user_id);

    CREATE TABLE IF NOT EXISTS project_members (
      project_id         TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role               TEXT    NOT NULL CHECK (role IN ('owner','editor','viewer')),
      granted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      granted_at         INTEGER NOT NULL,
      PRIMARY KEY (project_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

    CREATE TABLE IF NOT EXISTS project_settings (
      project_id    TEXT PRIMARY KEY REFERENCES projects(id),
      theme_id      TEXT,
      primary_color TEXT,
      accent_color  TEXT,
      sidebar_color TEXT,
      logo_path     TEXT,
      execution_provider TEXT,
      execution_provider_secondary TEXT,
      execution_provider_fallback TEXT,
      execution_model TEXT,
      execution_model_primary TEXT,
      execution_model_secondary TEXT,
      execution_model_fallback TEXT,
      fallback_policy TEXT,
      model_tier TEXT,
      monthly_cost_cap_usd REAL,
      daily_cost_cap_usd REAL
    );

    CREATE TABLE IF NOT EXISTS chat_projects (
      chat_id    TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS project_credentials (
      project_id  TEXT NOT NULL REFERENCES projects(id),
      service     TEXT NOT NULL,
      key         TEXT NOT NULL,
      value       BLOB NOT NULL,
      iv          BLOB NOT NULL,
      tag         BLOB NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (project_id, service, key)
    );

    CREATE TABLE IF NOT EXISTS installed_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      integration_id TEXT NOT NULL,
      status TEXT NOT NULL,
      account TEXT,
      last_verified_at INTEGER,
      last_error TEXT,
      installed_at INTEGER NOT NULL,
      UNIQUE(project_id, integration_id)
    );

    CREATE INDEX IF NOT EXISTS idx_installed_integrations_project
      ON installed_integrations(project_id);

    CREATE TABLE IF NOT EXISTS channel_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      direction    TEXT NOT NULL CHECK(direction IN ('in', 'out')),
      channel      TEXT NOT NULL,
      channel_name TEXT,
      bot_name     TEXT,
      project_id   TEXT,
      chat_id      TEXT NOT NULL,
      sender_name  TEXT,
      agent_id     TEXT,
      content      TEXT NOT NULL,
      content_type TEXT DEFAULT 'text',
      is_voice     INTEGER DEFAULT 0,
      is_group     INTEGER DEFAULT 0,
      duration_ms  INTEGER,
      tokens_used  INTEGER,
      error        TEXT,
      created_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_channel_log_project ON channel_log(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_log_channel ON channel_log(channel, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_log_time ON channel_log(created_at);

    CREATE TABLE IF NOT EXISTS action_items (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL REFERENCES projects(id),
      title                 TEXT NOT NULL,
      description           TEXT,
      status                TEXT NOT NULL,
      priority              TEXT NOT NULL DEFAULT 'medium',
      source                TEXT NOT NULL,
      proposed_by           TEXT NOT NULL,
      assigned_to           TEXT,
      executable_by_agent   INTEGER NOT NULL DEFAULT 0,
      parent_id             TEXT,
      target_date           INTEGER,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      completed_at          INTEGER,
      archived_at           INTEGER,
      last_run_at           INTEGER,
      last_run_result       TEXT,
      last_run_session      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_action_items_project_status ON action_items(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_action_items_status_target  ON action_items(status, target_date);
    CREATE INDEX IF NOT EXISTS idx_action_items_parent         ON action_items(parent_id);
    CREATE INDEX IF NOT EXISTS idx_action_items_archived       ON action_items(archived_at);

    CREATE TABLE IF NOT EXISTS action_item_comments (
      id         TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL,
      author     TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_action_item_comments_item ON action_item_comments(item_id, created_at);

    CREATE TABLE IF NOT EXISTS action_item_events (
      id          TEXT PRIMARY KEY,
      item_id     TEXT NOT NULL,
      actor       TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      old_value   TEXT,
      new_value   TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_action_item_events_item ON action_item_events(item_id, created_at);

    -- ── Knowledge Graph (Layer 4) ──────────────────────────────────
    CREATE TABLE IF NOT EXISTS entities (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      type        TEXT NOT NULL,
      summary     TEXT,
      project_id  TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts
      USING fts5(name, summary, content=entities);

    CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
      INSERT INTO entities_fts(rowid, name, summary) VALUES (new.id, new.name, new.summary);
    END;
    CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
      INSERT INTO entities_fts(entities_fts, rowid, name, summary) VALUES ('delete', old.id, old.name, old.summary);
    END;
    CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
      INSERT INTO entities_fts(entities_fts, rowid, name, summary) VALUES ('delete', old.id, old.name, old.summary);
      INSERT INTO entities_fts(rowid, name, summary) VALUES (new.id, new.name, new.summary);
    END;

    CREATE TABLE IF NOT EXISTS observations (
      id          INTEGER PRIMARY KEY,
      entity_id   INTEGER NOT NULL REFERENCES entities(id),
      content     TEXT NOT NULL,
      valid_from  INTEGER NOT NULL,
      valid_until INTEGER,
      source      TEXT NOT NULL,
      confidence  REAL NOT NULL DEFAULT 1.0,
      created_at  INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts
      USING fts5(content, content=observations);

    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO observations_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TABLE IF NOT EXISTS relations (
      id              INTEGER PRIMARY KEY,
      from_entity_id  INTEGER NOT NULL REFERENCES entities(id),
      to_entity_id    INTEGER NOT NULL REFERENCES entities(id),
      relation_type   TEXT NOT NULL,
      fact            TEXT,
      valid_from      INTEGER NOT NULL,
      valid_until     INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity_id);
    CREATE INDEX IF NOT EXISTS idx_observations_entity ON observations(entity_id);
    CREATE INDEX IF NOT EXISTS idx_observations_valid ON observations(valid_until);

    CREATE TABLE IF NOT EXISTS kv_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Rentcast API cache + monthly call log. Rentcast Developer tier caps
    -- at 50 calls/month; the property scout paw would burn that in one
    -- run without gating. rentcast_cache stores full response bodies
    -- keyed on (endpoint, query_string) with per-entry TTL. rentcast_call_log
    -- is an append-only counter used to enforce the monthly budget.
    -- See scripts/rentcast-cli.ts for the wrapper that reads/writes both.
    CREATE TABLE IF NOT EXISTS rentcast_cache (
      key           TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      cached_at     INTEGER NOT NULL,
      ttl_ms        INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rentcast_call_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint       TEXT NOT NULL,
      query          TEXT NOT NULL,
      called_at      INTEGER NOT NULL,
      status_code    INTEGER NOT NULL,
      bytes_returned INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_rentcast_log_called_at ON rentcast_call_log(called_at);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      user_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      tool_calls TEXT,
      token_count INTEGER,
      created_at INTEGER NOT NULL,
      summarized_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_time ON chat_messages(chat_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_project ON chat_messages(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id, created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
      content, content='chat_messages', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;

    CREATE TABLE IF NOT EXISTS chat_summaries (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      summary TEXT NOT NULL,
      key_topics TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_summaries_chat_time ON chat_summaries(chat_id, period_end DESC);

    CREATE TABLE IF NOT EXISTS extraction_runs (
      id INTEGER PRIMARY KEY,
      run_type TEXT NOT NULL CHECK (run_type IN ('heuristic','batch_llm','summarization')),
      project_id TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      messages_processed INTEGER DEFAULT 0,
      entities_created INTEGER DEFAULT 0,
      observations_created INTEGER DEFAULT 0,
      summaries_created INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_extraction_runs_started ON extraction_runs(started_at DESC);
  `)

  // ===========================================================================
  // Paw Broker domain schema (mirrored from server/src/db.ts).
  //
  // Why a mirror: paw collectors live in this process (`src/paws/collectors/*`)
  // and call getDb() -> bot DB. Broker tables originate in the server process
  // for the dashboard, but collectors need read+write access for INSERT (deals,
  // father_broker_listings, tax_events, cost_seg_studies, financing_events).
  // Easier to replicate schema than to open a second DB handle. ADR-011.
  //
  // Drift discipline: keep CREATE TABLE shapes byte-identical between this
  // block and server/src/db.ts. Add migration helpers to the ALTER block below
  // when adding columns later. The participation_log idx names and CHECK
  // constraints must match -- the dashboard's read queries assume identical
  // column ordering.
  // ===========================================================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS properties (
      id                 TEXT    PRIMARY KEY,
      project_id         TEXT    NOT NULL,
      address            TEXT    NOT NULL,
      zip                TEXT,
      county             TEXT,
      lat                REAL,
      lng                REAL,
      beds               INTEGER,
      baths              REAL,
      sqft               INTEGER,
      year_built         INTEGER,
      property_type      TEXT,
      use_type           TEXT    CHECK(use_type IN ('str','ltr','primary','flip','vacant') OR use_type IS NULL),
      acquisition_date   TEXT,
      acquisition_price  REAL,
      cost_basis         REAL,
      current_arv        REAL,
      brrrr_phase        TEXT    CHECK(brrrr_phase IN ('buy','rehab','rent','refi','recycle','exit') OR brrrr_phase IS NULL),
      str_listing_url    TEXT,
      status             TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','sold','under_contract','passed','archived')),
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_properties_project ON properties(project_id);
    CREATE INDEX IF NOT EXISTS idx_properties_use_type ON properties(project_id, use_type);

    CREATE TABLE IF NOT EXISTS improvements (
      id              TEXT    PRIMARY KEY,
      project_id      TEXT    NOT NULL,
      property_id     TEXT    NOT NULL,
      description     TEXT    NOT NULL,
      cost            REAL    NOT NULL,
      date            TEXT,
      photos_url      TEXT,
      receipts_url    TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_improvements_project ON improvements(project_id);
    CREATE INDEX IF NOT EXISTS idx_improvements_property ON improvements(property_id);

    CREATE TABLE IF NOT EXISTS deals (
      id                 TEXT    PRIMARY KEY,
      project_id         TEXT    NOT NULL,
      source_paw_id      TEXT,
      address            TEXT    NOT NULL,
      zip                TEXT,
      list_price         REAL,
      max_offer          REAL,
      est_arv            REAL,
      est_rehab          REAL,
      est_rent_monthly   REAL,
      est_str_adr        REAL,
      est_str_occupancy  REAL,
      est_cap_rate       REAL,
      est_coc            REAL,
      deal_type          TEXT    CHECK(deal_type IN ('str','ltr-brrrr','flip','hold','wholesale') OR deal_type IS NULL),
      status             TEXT    NOT NULL DEFAULT 'sourced' CHECK(status IN ('sourced','under-review','under-contract','closed','passed')),
      severity           INTEGER,
      notes              TEXT,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deals_project_status ON deals(project_id, status);
    CREATE INDEX IF NOT EXISTS idx_deals_severity ON deals(project_id, severity DESC);

    CREATE TABLE IF NOT EXISTS comps (
      id              TEXT    PRIMARY KEY,
      project_id      TEXT    NOT NULL,
      subject_address TEXT    NOT NULL,
      comp_address    TEXT    NOT NULL,
      sold_price      REAL,
      sold_date       TEXT,
      beds            INTEGER,
      baths           REAL,
      sqft            INTEGER,
      distance_mi     REAL,
      source          TEXT,
      fetched_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comps_project_subject ON comps(project_id, subject_address);

    CREATE TABLE IF NOT EXISTS str_comps (
      id              TEXT    PRIMARY KEY,
      project_id      TEXT    NOT NULL,
      subject_address TEXT    NOT NULL,
      listing_url     TEXT,
      adr             REAL,
      occupancy_pct   REAL,
      revpar          REAL,
      beds            INTEGER,
      baths           REAL,
      source          TEXT,
      fetched_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_str_comps_project_subject ON str_comps(project_id, subject_address);

    CREATE TABLE IF NOT EXISTS rehab_estimates (
      id              TEXT    PRIMARY KEY,
      project_id      TEXT    NOT NULL,
      property_id     TEXT    NOT NULL,
      scope_json      TEXT,
      total_est       REAL,
      total_actual    REAL,
      contingency_pct REAL,
      status          TEXT    NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','complete','cancelled')),
      started_at      INTEGER,
      completed_at    INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rehab_property ON rehab_estimates(property_id);

    CREATE TABLE IF NOT EXISTS financing_events (
      id              TEXT    PRIMARY KEY,
      project_id      TEXT    NOT NULL,
      property_id     TEXT,
      event_type      TEXT    NOT NULL CHECK(event_type IN ('purchase','refi','heloc','heloc_draw','payoff','hard_money','dscr_loan','seller_finance','other')),
      loan_amount     REAL,
      rate            REAL,
      term_months     INTEGER,
      ltv             REAL,
      lender          TEXT,
      closing_date    TEXT,
      points          REAL,
      closing_costs   REAL,
      notes           TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_financing_property ON financing_events(property_id);

    CREATE TABLE IF NOT EXISTS tenants (
      id               TEXT    PRIMARY KEY,
      project_id       TEXT    NOT NULL,
      name             TEXT    NOT NULL,
      email            TEXT,
      phone            TEXT,
      screening_score  INTEGER,
      notes            TEXT,
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tenants_project ON tenants(project_id);

    CREATE TABLE IF NOT EXISTS leases (
      id              TEXT    PRIMARY KEY,
      project_id      TEXT    NOT NULL,
      property_id     TEXT    NOT NULL,
      tenant_id       TEXT    NOT NULL,
      start_date      TEXT,
      end_date        TEXT,
      monthly_rent    REAL,
      deposit         REAL,
      status          TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','terminated','holdover')),
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leases_property ON leases(property_id);
    CREATE INDEX IF NOT EXISTS idx_leases_tenant ON leases(tenant_id);

    CREATE TABLE IF NOT EXISTS str_bookings (
      id              TEXT    PRIMARY KEY,
      project_id      TEXT    NOT NULL,
      property_id     TEXT    NOT NULL,
      platform        TEXT    NOT NULL CHECK(platform IN ('airbnb','vrbo','direct','booking_com','other')),
      guest_name      TEXT,
      check_in        TEXT,
      check_out       TEXT,
      nights          INTEGER,
      gross_rev       REAL,
      fees            REAL,
      net_payout      REAL,
      status          TEXT    NOT NULL DEFAULT 'confirmed' CHECK(status IN ('inquiry','confirmed','in_stay','completed','cancelled')),
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_str_bookings_property ON str_bookings(property_id);
    CREATE INDEX IF NOT EXISTS idx_str_bookings_check_in ON str_bookings(project_id, check_in);

    CREATE TABLE IF NOT EXISTS expenses (
      id              TEXT    PRIMARY KEY,
      project_id      TEXT    NOT NULL,
      property_id     TEXT,
      category        TEXT    NOT NULL CHECK(category IN ('mortgage','tax','insurance','repair','capex','utility','mgmt','cleaning','supplies','marketing','legal','other')),
      amount          REAL    NOT NULL,
      occurred_on     TEXT    NOT NULL,
      vendor          TEXT,
      deductible      INTEGER NOT NULL DEFAULT 1,
      notes           TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_property ON expenses(property_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_occurred ON expenses(project_id, occurred_on);

    CREATE TABLE IF NOT EXISTS tax_events (
      id              TEXT    PRIMARY KEY,
      project_id      TEXT    NOT NULL,
      event_type      TEXT    NOT NULL CHECK(event_type IN ('1031_id_clock','1031_close_clock','q_estimate','reps_milestone','str_milestone','cost_seg_engagement','obbb_election','ltta_recert','property_tax_due','other')),
      property_id     TEXT,
      due_date        TEXT,
      amount          REAL,
      hours           REAL,
      status          TEXT    NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','missed','waived')),
      notes           TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tax_events_due ON tax_events(project_id, due_date);

    CREATE TABLE IF NOT EXISTS participation_log (
      id              TEXT    PRIMARY KEY,
      project_id      TEXT    NOT NULL,
      property_id     TEXT,
      date            TEXT    NOT NULL,
      activity        TEXT    NOT NULL,
      hours           REAL    NOT NULL,
      evidence_url    TEXT,
      participant     TEXT    NOT NULL CHECK(participant IN ('mariano','father','spouse','contractor','manager','other')),
      counted_for     TEXT    NOT NULL CHECK(counted_for IN ('str','reps','both','none')),
      notes           TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_participation_property ON participation_log(property_id);
    CREATE INDEX IF NOT EXISTS idx_participation_project_date ON participation_log(project_id, date);
    CREATE INDEX IF NOT EXISTS idx_participation_counted ON participation_log(project_id, counted_for);

    CREATE TABLE IF NOT EXISTS tax_abatements (
      id                  TEXT    PRIMARY KEY,
      project_id          TEXT    NOT NULL,
      property_id         TEXT    NOT NULL,
      abatement_program   TEXT    NOT NULL,
      start_date          TEXT,
      end_date            TEXT,
      frozen_assessment   REAL,
      current_assessment  REAL,
      annual_savings      REAL,
      recert_due          TEXT,
      notes               TEXT,
      created_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tax_abatements_property ON tax_abatements(property_id);
    CREATE INDEX IF NOT EXISTS idx_tax_abatements_recert ON tax_abatements(project_id, recert_due);

    CREATE TABLE IF NOT EXISTS cost_seg_studies (
      id                  TEXT    PRIMARY KEY,
      project_id          TEXT    NOT NULL,
      property_id         TEXT    NOT NULL,
      engagement_date     TEXT,
      firm                TEXT,
      study_cost          REAL,
      total_basis         REAL,
      accelerated_5yr     REAL,
      accelerated_15yr    REAL,
      sl_27_5yr           REAL,
      year1_deduction     REAL,
      status              TEXT    NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','engaged','complete','cancelled')),
      notes               TEXT,
      created_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cost_seg_property ON cost_seg_studies(property_id);

    CREATE TABLE IF NOT EXISTS contractors (
      id                   TEXT    PRIMARY KEY,
      project_id           TEXT    NOT NULL,
      name                 TEXT    NOT NULL,
      trade                TEXT,
      phone                TEXT,
      license              TEXT,
      on_time_pct          REAL,
      budget_variance_pct  REAL,
      callback_rate        REAL,
      last_used_at         TEXT,
      notes                TEXT,
      created_at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contractors_project_trade ON contractors(project_id, trade);

    CREATE TABLE IF NOT EXISTS father_broker_listings (
      id            TEXT    PRIMARY KEY,
      project_id    TEXT    NOT NULL,
      address       TEXT    NOT NULL,
      zip           TEXT,
      list_price    REAL,
      off_market    INTEGER NOT NULL DEFAULT 1,
      source        TEXT    CHECK(source IN ('mls','pocket','whisper','other') OR source IS NULL),
      notes         TEXT,
      received_at   INTEGER NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','passed','pursued')),
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_father_broker_status ON father_broker_listings(project_id, status, received_at DESC);

    CREATE TABLE IF NOT EXISTS investments (
      id            TEXT    PRIMARY KEY,
      project_id    TEXT    NOT NULL,
      asset_type    TEXT    NOT NULL CHECK(asset_type IN ('stock','etf','bond','crypto','retirement_401k','retirement_ira','retirement_solo_401k','retirement_sdira','cash','hysa','treasury','other')),
      account_label TEXT,
      symbol        TEXT,
      quantity      REAL,
      value_usd     REAL,
      as_of         TEXT,
      notes         TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_investments_project ON investments(project_id);
    CREATE INDEX IF NOT EXISTS idx_investments_asof ON investments(project_id, as_of DESC);
  `)

  addColumnIfMissing(db, 'entities', 'last_seen_at', 'INTEGER')
  addColumnIfMissing(db, 'observations', 'source_id', 'INTEGER')
  addColumnIfMissing(db, 'observations', 'occurred_at', 'INTEGER')
  addColumnIfMissing(db, 'observations', 'project_id', 'TEXT')

  if (!hasColumn(db, 'project_settings', 'execution_provider')) {
    db.exec(`ALTER TABLE project_settings ADD COLUMN execution_provider TEXT`)
  }
  if (!hasColumn(db, 'project_settings', 'execution_provider_secondary')) {
    db.exec(`ALTER TABLE project_settings ADD COLUMN execution_provider_secondary TEXT`)
  }
  if (!hasColumn(db, 'project_settings', 'execution_provider_fallback')) {
    db.exec(`ALTER TABLE project_settings ADD COLUMN execution_provider_fallback TEXT`)
  }
  if (!hasColumn(db, 'project_settings', 'execution_model')) {
    db.exec(`ALTER TABLE project_settings ADD COLUMN execution_model TEXT`)
  }
  if (!hasColumn(db, 'project_settings', 'execution_model_primary')) {
    db.exec(`ALTER TABLE project_settings ADD COLUMN execution_model_primary TEXT`)
  }
  if (!hasColumn(db, 'project_settings', 'execution_model_secondary')) {
    db.exec(`ALTER TABLE project_settings ADD COLUMN execution_model_secondary TEXT`)
  }
  if (!hasColumn(db, 'project_settings', 'execution_model_fallback')) {
    db.exec(`ALTER TABLE project_settings ADD COLUMN execution_model_fallback TEXT`)
  }
  if (!hasColumn(db, 'project_settings', 'fallback_policy')) {
    db.exec(`ALTER TABLE project_settings ADD COLUMN fallback_policy TEXT`)
  }
  if (!hasColumn(db, 'project_settings', 'model_tier')) {
    db.exec(`ALTER TABLE project_settings ADD COLUMN model_tier TEXT`)
  }
  if (!hasColumn(db, 'project_settings', 'monthly_cost_cap_usd')) {
    db.exec(`ALTER TABLE project_settings ADD COLUMN monthly_cost_cap_usd REAL`)
  }
  if (!hasColumn(db, 'project_settings', 'daily_cost_cap_usd')) {
    db.exec(`ALTER TABLE project_settings ADD COLUMN daily_cost_cap_usd REAL`)
  }

  // Project lifecycle columns (must match server/src/db.ts ensureBotProjectLifecycleSchema).
  //
  // DDL DRIFT CAVEAT: if the initial CREATE TABLE IF NOT EXISTS projects statement
  // earlier in initDatabase() is ever updated to include these columns, the
  // guards below become silently dead (hasColumn returns true on a fresh DB).
  // That's not a runtime bug -- the end-state schema is identical -- but the
  // migration block becomes misleading dead code. If you update the CREATE TABLE,
  // either also delete the matching hasColumn block here, or leave a comment
  // noting both places were updated together.
  if (!hasColumn(db, 'projects', 'status')) {
    db.exec(`ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived'))`)
  }
  if (!hasColumn(db, 'projects', 'updated_at')) {
    db.exec(`ALTER TABLE projects ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`)
    db.exec(`UPDATE projects SET updated_at = created_at WHERE updated_at = 0`)
  }
  if (!hasColumn(db, 'projects', 'paused_at')) {
    db.exec(`ALTER TABLE projects ADD COLUMN paused_at INTEGER`)
  }
  if (!hasColumn(db, 'projects', 'archived_at')) {
    db.exec(`ALTER TABLE projects ADD COLUMN archived_at INTEGER`)
  }
  if (!hasColumn(db, 'projects', 'auto_archive_days')) {
    db.exec(`ALTER TABLE projects ADD COLUMN auto_archive_days INTEGER`)
  }

  // Idempotent: add archived_at to project_credentials if missing
  if (!hasColumn(db, 'project_credentials', 'archived_at')) {
    db.exec('ALTER TABLE project_credentials ADD COLUMN archived_at INTEGER')
    logger.info('Added archived_at column to project_credentials')
  }

  // Link action_items to research_items (research_items lives in server DB;
  // cross-DB FK follows the same pattern as action_item_chat_messages.item_id)
  ensureActionItemsResearchLink(db)

  // Multi-project migration: add project_id columns. Using hasColumn instead of
  // try/catch keeps real errors (locked DB, disk full) from being swallowed.
  const migrationTables = [
    'sessions', 'memories', 'scheduled_tasks', 'security_findings',
    'guard_events', 'interaction_feedback', 'learned_skills',
  ]
  for (const table of migrationTables) {
    if (!hasColumn(db, table, 'project_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT DEFAULT 'default'`)
      logger.info('Added project_id column to %s', table)
    }
  }

  // Seed default project (default personal assistant)
  const seedNow = Date.now()
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, slug, display_name, icon, created_at)
     VALUES ('default', 'default', 'default', 'Personal Assistant', NULL, ?)`,
  ).run(seedNow)

  // Create indexes for project_id columns
  const indexDefs: [string, string, string][] = [
    ['idx_memories_project', 'memories', 'project_id'],
    ['idx_tasks_project', 'scheduled_tasks', 'project_id'],
    ['idx_findings_project', 'security_findings', 'project_id'],
    ['idx_guard_project', 'guard_events', 'project_id'],
    ['idx_feedback_project', 'interaction_feedback', 'project_id'],
    ['idx_skills_project', 'learned_skills', 'project_id'],
    ['idx_sessions_project', 'sessions', 'project_id'],
  ]
  // CREATE INDEX IF NOT EXISTS is idempotent on its own. Don't swallow errors
  // here -- a failure means the referenced table doesn't exist, which is a
  // real bug we want to surface during startup instead of hiding.
  for (const [idxName, table, col] of indexDefs) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${table}(${col})`)
  }

  const promptOverridesApplied = reconcileTaskPromptOverrides()
  if (promptOverridesApplied > 0) {
    logger.info({ count: promptOverridesApplied }, 'Reconciled scheduled task prompt overrides')
  }

  // Paws Mode tables
  initPawsTables(db)



  // Versioned migrations (post-v0 schema changes)
  runMigrations(db)

  // Mirror of server-side seedBrokerProperties(). Bot-side collectors call
  // getDb() so they need the anchor properties locally for participation /
  // cost-seg / refi candidate scans to find a target. Idempotent on count.
  // Drift discipline: keep this function in lockstep with the server-side
  // copy in server/src/db.ts. ADR-013.
  try {
    seedBrokerPropertiesBot(db)
  } catch (err) {
    logger.warn({ err }, 'Failed to seed broker anchor properties -- continuing')
  }

  logger.info({ dbPath }, 'Database initialized')
  return db
}

/**
 * Seed Paw Broker anchor properties on the bot DB.
 * Mirrors server/src/db.ts seedBrokerProperties() byte-for-byte except for
 * the explicit db argument (the server module captures `db` from outer
 * scope; the bot side uses the helper signature). Idempotent on row count.
 */
function seedBrokerPropertiesBot(dbh: Database.Database): void {
  const count = (dbh.prepare("SELECT COUNT(*) AS c FROM properties WHERE project_id = 'broker'").get() as { c: number }).c
  if (count > 0) return

  const now = Date.now()
  const insertProp = dbh.prepare(`
    INSERT INTO properties (
      id, project_id, address, zip, county, lat, lng, beds, baths, sqft, year_built,
      property_type, use_type, acquisition_date, acquisition_price, cost_basis, current_arv,
      brrrr_phase, str_listing_url, status, created_at, updated_at
    ) VALUES (
      @id, 'broker', @address, @zip, @county, @lat, @lng, @beds, @baths, @sqft, @year_built,
      @property_type, @use_type, @acquisition_date, @acquisition_price, @cost_basis, @current_arv,
      @brrrr_phase, @str_listing_url, 'active', @now, @now
    )
  `)
  const insertImp = dbh.prepare(`
    INSERT INTO improvements (id, project_id, property_id, description, cost, date, photos_url, receipts_url, created_at)
    VALUES (@id, 'broker', @property_id, @description, @cost, @date, NULL, NULL, @now)
  `)

  const tx = dbh.transaction(() => {
    insertProp.run({
      id: 'broker--1932-w-shunk',
      address: '1932 W Shunk Street',
      zip: '19145',
      county: 'Philadelphia',
      lat: 39.9215,
      lng: -75.1810,
      beds: null,
      baths: null,
      sqft: null,
      year_built: null,
      property_type: 'rowhome',
      use_type: 'ltr',
      acquisition_date: null,
      acquisition_price: null,
      cost_basis: null,
      current_arv: null,
      brrrr_phase: 'rent',
      str_listing_url: null,
      now,
    })
    insertProp.run({
      id: 'broker--114-michigan',
      address: '114 Michigan Ave',
      zip: null,
      county: null,
      lat: null,
      lng: null,
      beds: null,
      baths: null,
      sqft: null,
      year_built: null,
      property_type: null,
      use_type: 'primary',
      acquisition_date: null,
      acquisition_price: null,
      cost_basis: null,
      current_arv: null,
      brrrr_phase: null,
      str_listing_url: null,
      now,
    })
    // Improvements that raised 114 Michigan basis. Costs 0 until the operator fills.
    insertImp.run({
      id: 'broker--114-michigan--imp-major-repairs',
      property_id: 'broker--114-michigan',
      description: 'Major repairs (basis raise)',
      cost: 0,
      date: null,
      now,
    })
    insertImp.run({
      id: 'broker--114-michigan--imp-3car-garage',
      property_id: 'broker--114-michigan',
      description: '3-car garage build (basis raise)',
      cost: 0,
      date: null,
      now,
    })
    insertImp.run({
      id: 'broker--114-michigan--imp-attic',
      property_id: 'broker--114-michigan',
      description: '2nd-floor attic build-out (basis raise)',
      cost: 0,
      date: null,
      now,
    })
  })
  tx()
  logger.info({ properties: 2, improvements: 3 }, 'Seeded Paw Broker anchor properties (bot DB)')
}

export function checkpointAndCloseDatabase(): void {
  if (!db) return
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (err) {
    logger.warn({ err }, 'Failed to checkpoint main database before shutdown')
  }
  try {
    db.close()
  } catch (err) {
    logger.warn({ err }, 'Failed to close main database before shutdown')
  } finally {
    db = undefined as unknown as Database.Database
  }
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDatabase() first')
  return db
}

// ---------------------------------------------------------------------------
// kv_settings helpers (shared string KV store)
// ---------------------------------------------------------------------------

/**
 * Read a string value from kv_settings.
 * Returns null if the key does not exist or the DB is unavailable.
 */
export function getKvSetting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM kv_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row ? row.value : null
  } catch {
    return null
  }
}

/**
 * Write a string value to kv_settings. Overwrites existing values.
 * Errors are logged but not rethrown so caller paths (e.g. scheduler ticks)
 * do not crash when the DB is briefly unavailable.
 */
export function setKvSetting(key: string, value: string): void {
  try {
    getDb()
      .prepare('INSERT OR REPLACE INTO kv_settings (key, value) VALUES (?, ?)')
      .run(key, value)
  } catch (err) {
    logger.warn({ err, key }, '[kv_settings] failed to persist value')
  }
}

export function initVecTable(dbConn: Database.Database, dimensions: number): void {
  const stored = (
    dbConn.prepare('SELECT value FROM kv_settings WHERE key = ?').get('embedding_dimensions') as
      | { value: string }
      | undefined
  )?.value

  if (stored && parseInt(stored) !== dimensions) {
    logger.warn(
      { stored, dimensions },
      'Embedding dimension mismatch — vector search disabled. Drop vec_embeddings and re-run knowledge:seed to fix.',
    )
    return
  }

  try {
    const sql = `CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
      target_type TEXT,
      target_id   INTEGER,
      embedding   float[${dimensions}]
    )`
    dbConn.exec(sql)
    dbConn
      .prepare("INSERT OR IGNORE INTO kv_settings (key, value) VALUES ('embedding_dimensions', ?)")
      .run(String(dimensions))
  } catch (err) {
    logger.warn({ err }, 'Failed to create vec_embeddings — vector search disabled')
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function getSession(chatId: string, agentId?: string): Session | undefined {
  const key = agentId ? chatId + ':' + agentId : chatId
  return getDb()
    .prepare('SELECT chat_id, session_id, updated_at FROM sessions WHERE chat_id = ?')
    .get(key) as Session | undefined
}

export function setSession(chatId: string, sessionId: string, agentId?: string): void {
  const key = agentId ? chatId + ':' + agentId : chatId
  getDb()
    .prepare(
      `INSERT INTO sessions (chat_id, session_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    )
    .run(key, sessionId, Date.now())
}

export function clearSession(chatId: string, agentId?: string): void {
  const key = agentId ? chatId + ':' + agentId : chatId
  getDb().prepare('DELETE FROM sessions WHERE chat_id = ?').run(key)
}

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

export function searchMemories(
  chatId: string,
  query: string,
  limit: number = 5,
  projectId?: string,
): Memory[] {
  if (projectId) {
    return getDb()
      .prepare(
        `SELECT m.*
         FROM memories m
         JOIN memories_fts f ON f.rowid = m.id
         WHERE f.content MATCH ?
           AND m.chat_id = ?
           AND m.project_id = ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, chatId, projectId, limit) as Memory[]
  }
  return getDb()
    .prepare(
      `SELECT m.*
       FROM memories m
       JOIN memories_fts f ON f.rowid = m.id
       WHERE f.content MATCH ?
         AND m.chat_id = ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, chatId, limit) as Memory[]
}

export function insertMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string,
  projectId?: string,
): number {
  const now = Date.now()
  const info = getDb()
    .prepare(
      `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, project_id)
       VALUES (?, ?, ?, ?, 1.0, ?, ?, ?)`,
    )
    .run(chatId, topicKey ?? null, content, sector, now, now, projectId ?? 'default')
  return Number(info.lastInsertRowid)
}

export function getRecentMemories(chatId: string, limit: number = 5, projectId?: string): Memory[] {
  if (projectId) {
    return getDb()
      .prepare(
        `SELECT * FROM memories
         WHERE chat_id = ?
           AND project_id = ?
         ORDER BY accessed_at DESC
         LIMIT ?`,
      )
      .all(chatId, projectId, limit) as Memory[]
  }
  return getDb()
    .prepare(
      `SELECT * FROM memories
       WHERE chat_id = ?
       ORDER BY accessed_at DESC
       LIMIT ?`,
    )
    .all(chatId, limit) as Memory[]
}

export function touchMemory(id: number, accessedAt?: number, newSalience?: number): void {
  const now = accessedAt ?? Date.now()
  if (newSalience !== undefined) {
    getDb()
      .prepare('UPDATE memories SET accessed_at = ?, salience = ? WHERE id = ?')
      .run(now, newSalience, id)
  } else {
    getDb()
      .prepare('UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?')
      .run(now, id)
  }
}

export interface SaveMemoryInput {
  chat_id: string
  topic_key: string
  content: string
  sector: 'semantic' | 'episodic'
  salience: number
  created_at: number
  accessed_at: number
  project_id?: string
}

export function saveMemory(input: SaveMemoryInput): number {
  const info = getDb()
    .prepare(
      `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.chat_id, input.topic_key, input.content, input.sector, input.salience, input.created_at, input.accessed_at, input.project_id ?? 'default')
  return Number(info.lastInsertRowid)
}

export function decayMemories(): number {
  const info = getDb()
    .prepare('UPDATE memories SET salience = MAX(salience - 0.05, 0.0) WHERE salience > 0')
    .run()
  return info.changes
}

export function deleteDecayedMemories(threshold: number = 0.1): number {
  const info = getDb()
    .prepare('DELETE FROM memories WHERE salience < ?')
    .run(threshold)
  return info.changes
}

// ---------------------------------------------------------------------------
// Scheduled Tasks
// ---------------------------------------------------------------------------

export function getDueTasks(): ScheduledTask[] {
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run <= ?
       ORDER BY next_run ASC`,
    )
    .all(Date.now()) as ScheduledTask[]
}

/**
 * List "backlog" tasks — active tasks whose `next_run` is more than
 * `maxAgeMs` in the past. Used by the scheduler to skip catch-up runs after a
 * bot outage: if the bot was offline overnight, firing 20 tasks at once at
 * restart is worse than skipping them. This is a read-only helper; the
 * caller is responsible for computing the next future `next_run` and calling
 * `updateTaskAfterRun(id, 'skipped (backlog)', nextRun)`.
 */
export function getBacklogTasks(maxAgeMs: number): ScheduledTask[] {
  const cutoff = Date.now() - maxAgeMs
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run < ?
       ORDER BY next_run ASC`,
    )
    .all(cutoff) as ScheduledTask[]
}

export function createTask(
  id: string,
  chatId: string,
  prompt: string,
  schedule: string,
  nextRun: number,
  projectId: string = 'default',
): void {
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, created_at, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, chatId, prompt, schedule, nextRun, Date.now(), projectId)
}

export function updateTaskAfterRun(
  id: string,
  lastResult: string,
  nextRun: number,
): void {
  getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET last_run = ?, last_result = ?, next_run = ?
       WHERE id = ?`,
    )
    .run(Date.now(), lastResult, nextRun, id)
}

/**
 * Reset tasks stuck with last_result = 'running...' from a previous crash.
 * Called on bot startup to clear stale state.
 */
export function clearStaleRunningTasks(): number {
  const result = getDb()
    .prepare(
      `UPDATE scheduled_tasks
       SET last_result = 'Interrupted: process restarted during execution'
       WHERE last_result = 'running...'`,
    )
    .run()
  return result.changes
}

export function getTask(id: string): ScheduledTask | undefined {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as ScheduledTask | undefined
}

export function listTasks(chatId?: string, projectId?: string): ScheduledTask[] {
  if (chatId && projectId) {
    return getDb()
      .prepare('SELECT * FROM scheduled_tasks WHERE chat_id = ? AND project_id = ? ORDER BY created_at DESC')
      .all(chatId, projectId) as ScheduledTask[]
  }
  if (chatId) {
    return getDb()
      .prepare('SELECT * FROM scheduled_tasks WHERE chat_id = ? ORDER BY created_at DESC')
      .all(chatId) as ScheduledTask[]
  }
  if (projectId) {
    return getDb()
      .prepare('SELECT * FROM scheduled_tasks WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as ScheduledTask[]
  }
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[]
}

export function deleteTask(id: string): boolean {
  const info = getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
  return info.changes > 0
}

export function pauseTask(id: string): void {
  getDb()
    .prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?")
    .run(id)
}

export function resumeTask(id: string, nextRun: number): void {
  getDb()
    .prepare("UPDATE scheduled_tasks SET status = 'active', next_run = ? WHERE id = ?")
    .run(nextRun, id)
}

// ---------------------------------------------------------------------------
// Guard Events
// ---------------------------------------------------------------------------

export interface GuardEventRow {
  id: string
  timestamp: number
  chat_id: string
  event_type: string
  triggered_layers: string | null
  block_reason: string | null
  original_message: string | null
  sanitized_message: string | null
  layer_results: string | null
  latency_ms: number | null
  request_id: string
}

export function getRecentGuardEvents(
  eventType?: string,
  limit: number = 50,
): GuardEventRow[] {
  const db = getDb()
  if (eventType) {
    return db
      .prepare('SELECT * FROM guard_events WHERE event_type = ? ORDER BY timestamp DESC LIMIT ?')
      .all(eventType, limit) as GuardEventRow[]
  }
  return db
    .prepare('SELECT * FROM guard_events ORDER BY timestamp DESC LIMIT ?')
    .all(limit) as GuardEventRow[]
}

export function getGuardEventStats(): { blocked: number; flagged: number; passed: number; total: number } {
  const db = getDb()
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN event_type = 'BLOCKED' THEN 1 ELSE 0 END) as blocked,
      SUM(CASE WHEN event_type = 'FLAGGED' THEN 1 ELSE 0 END) as flagged,
      SUM(CASE WHEN event_type = 'PASSED' THEN 1 ELSE 0 END) as passed,
      COUNT(*) as total
    FROM guard_events
  `).get() as { blocked: number; flagged: number; passed: number; total: number }
  return row
}

// ---------------------------------------------------------------------------
// Interaction Feedback (Learning)
// ---------------------------------------------------------------------------

export function saveFeedback(input: {
  id: string
  chat_id: string
  agent_id: string | null
  user_message: string
  bot_response: string
  feedback_type: 'correction' | 'explicit'
  feedback_note: string | null
  project_id?: string
}): void {
  getDb()
    .prepare(
      `INSERT INTO interaction_feedback (id, chat_id, agent_id, user_message, bot_response, feedback_type, feedback_note, created_at, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.chat_id, input.agent_id, input.user_message, input.bot_response, input.feedback_type, input.feedback_note, Date.now(), input.project_id ?? 'default')
}

export function getUnconsumedFeedback(projectId?: string): InteractionFeedback[] {
  if (projectId) {
    return getDb()
      .prepare('SELECT * FROM interaction_feedback WHERE consumed = 0 AND project_id = ? ORDER BY created_at ASC')
      .all(projectId) as InteractionFeedback[]
  }
  return getDb()
    .prepare('SELECT * FROM interaction_feedback WHERE consumed = 0 ORDER BY created_at ASC')
    .all() as InteractionFeedback[]
}

export function markFeedbackConsumed(ids: string[]): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  getDb()
    .prepare(`UPDATE interaction_feedback SET consumed = 1 WHERE id IN (${placeholders})`)
    .run(...ids)
}

// ---------------------------------------------------------------------------
// Learned Patches (Learning - Tier 1)
// ---------------------------------------------------------------------------

export function savePatch(input: {
  id: string
  agent_id: string | null
  feedback_id: string
  content: string
}): void {
  const now = Date.now()
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000 // 7 days in ms
  getDb()
    .prepare(
      `INSERT INTO learned_patches (id, agent_id, feedback_id, content, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.agent_id, input.feedback_id, input.content, now, expiresAt)
}

export function getActivePatches(agentId: string | null): LearnedPatch[] {
  const now = Date.now()
  return getDb()
    .prepare(
      `SELECT * FROM learned_patches
       WHERE (agent_id = ? OR agent_id IS NULL)
         AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .all(agentId, now) as LearnedPatch[]
}

export function deleteExpiredPatches(): number {
  const now = Date.now()
  const info = getDb()
    .prepare('DELETE FROM learned_patches WHERE expires_at <= ?')
    .run(now)
  return info.changes
}

// ---------------------------------------------------------------------------
// Learned Skills (Learning - Tier 2)
// ---------------------------------------------------------------------------

export function saveSkill(input: {
  uuid: string
  agent_id: string | null
  title: string
  content: string
  source_ids: string[]
  project_id?: string
}): number {
  const now = Date.now()
  const info = getDb()
    .prepare(
      `INSERT INTO learned_skills (uuid, agent_id, title, content, source_ids, created_at, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.uuid, input.agent_id, input.title, input.content, JSON.stringify(input.source_ids), now, input.project_id ?? 'default')
  return Number(info.lastInsertRowid)
}

export function updateSkillContent(uuid: string, content: string): void {
  getDb()
    .prepare('UPDATE learned_skills SET content = ? WHERE uuid = ?')
    .run(content, uuid)
}

export function searchSkills(agentId: string | null, query: string, limit: number = 3, projectId?: string): LearnedSkill[] {
  if (projectId) {
    return getDb()
      .prepare(
        `SELECT s.*
         FROM learned_skills s
         JOIN learned_skills_fts f ON f.rowid = s.id
         WHERE f.content MATCH ?
           AND (s.agent_id = ? OR s.agent_id IS NULL)
           AND s.status = 'active'
           AND s.project_id = ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, agentId, projectId, limit) as LearnedSkill[]
  }
  return getDb()
    .prepare(
      `SELECT s.*
       FROM learned_skills s
       JOIN learned_skills_fts f ON f.rowid = s.id
       WHERE f.content MATCH ?
         AND (s.agent_id = ? OR s.agent_id IS NULL)
         AND s.status = 'active'
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, agentId, limit) as LearnedSkill[]
}

export function touchSkill(id: number): void {
  const now = Date.now()
  getDb()
    .prepare('UPDATE learned_skills SET last_used = ? WHERE id = ?')
    .run(now, id)
}

export function getSkillsByAgent(agentId: string | null, projectId?: string): LearnedSkill[] {
  if (agentId && projectId) {
    return getDb()
      .prepare("SELECT * FROM learned_skills WHERE (agent_id = ? OR agent_id IS NULL) AND status = 'active' AND project_id = ? ORDER BY created_at DESC")
      .all(agentId, projectId) as LearnedSkill[]
  }
  if (agentId) {
    return getDb()
      .prepare("SELECT * FROM learned_skills WHERE (agent_id = ? OR agent_id IS NULL) AND status = 'active' ORDER BY created_at DESC")
      .all(agentId) as LearnedSkill[]
  }
  if (projectId) {
    return getDb()
      .prepare("SELECT * FROM learned_skills WHERE status = 'active' AND project_id = ? ORDER BY created_at DESC")
      .all(projectId) as LearnedSkill[]
  }
  return getDb()
    .prepare("SELECT * FROM learned_skills WHERE status = 'active' ORDER BY created_at DESC")
    .all() as LearnedSkill[]
}

export function decaySkillEffectiveness(uuid: string, amount: number = 0.2): void {
  getDb()
    .prepare(
      `UPDATE learned_skills
       SET effectiveness = MAX(effectiveness - ?, 0.0),
           status = CASE WHEN effectiveness - ? <= 0.0 THEN 'retired' ELSE status END
       WHERE uuid = ?`,
    )
    .run(amount, amount, uuid)
}

export function retireSkill(uuid: string): void {
  getDb()
    .prepare("UPDATE learned_skills SET status = 'retired' WHERE uuid = ?")
    .run(uuid)
}

export function getSkillStats(): { agent_id: string | null; skill_count: number; patch_count: number }[] {
  const now = Date.now()
  const skills = getDb()
    .prepare("SELECT agent_id, COUNT(*) as skill_count FROM learned_skills WHERE status = 'active' GROUP BY agent_id")
    .all() as { agent_id: string | null; skill_count: number }[]
  const patches = getDb()
    .prepare('SELECT agent_id, COUNT(*) as patch_count FROM learned_patches WHERE expires_at > ? GROUP BY agent_id')
    .all(now) as { agent_id: string | null; patch_count: number }[]

  const map = new Map<string, { agent_id: string | null; skill_count: number; patch_count: number }>()
  for (const s of skills) {
    const key = s.agent_id ?? '__global__'
    map.set(key, { agent_id: s.agent_id, skill_count: s.skill_count, patch_count: 0 })
  }
  for (const p of patches) {
    const key = p.agent_id ?? '__global__'
    const existing = map.get(key)
    if (existing) {
      existing.patch_count = p.patch_count
    } else {
      map.set(key, { agent_id: p.agent_id, skill_count: 0, patch_count: p.patch_count })
    }
  }
  return [...map.values()]
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function createProject(input: {
  id: string
  name: string
  slug: string
  display_name: string
  icon?: string
}): void {
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, slug, display_name, icon, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.name, input.slug, input.display_name, input.icon ?? null, Date.now())
}

export function getProject(id: string): Project | undefined {
  return getDb()
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as Project | undefined
}

export function getProjectBySlug(slug: string): Project | undefined {
  return getDb()
    .prepare('SELECT * FROM projects WHERE slug = ?')
    .get(slug) as Project | undefined
}

export function getProjectByName(name: string): Project | undefined {
  return getDb()
    .prepare('SELECT * FROM projects WHERE name = ? OR slug = ? OR display_name = ?')
    .get(name, name, name) as Project | undefined
}

export function listProjects(): Project[] {
  return getDb()
    .prepare('SELECT * FROM projects ORDER BY created_at ASC')
    .all() as Project[]
}

export function updateProject(id: string, updates: Partial<Pick<Project, 'name' | 'slug' | 'display_name' | 'icon'>>): void {
  const fields: string[] = []
  const values: unknown[] = []
  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
  if (updates.slug !== undefined) { fields.push('slug = ?'); values.push(updates.slug) }
  if (updates.display_name !== undefined) { fields.push('display_name = ?'); values.push(updates.display_name) }
  if (updates.icon !== undefined) { fields.push('icon = ?'); values.push(updates.icon) }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  values.push(Date.now())
  values.push(id)
  getDb().prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteProject(id: string): boolean {
  if (id === 'default') return false // never delete default (personal assistant project)
  const db = getDb()
  const tx = db.transaction(() => {
    for (const table of ['agents', 'messages', 'webhooks', 'project_integrations', 'project_credentials', 'project_settings']) {
      try { db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id) } catch { /* table may not exist */ }
    }
    return db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  })
  const info = tx()
  return info.changes > 0
}

// ---------------------------------------------------------------------------
// Project Settings
// ---------------------------------------------------------------------------

export function getProjectSettings(projectId: string): ProjectSettings | undefined {
  return getDb()
    .prepare('SELECT * FROM project_settings WHERE project_id = ?')
    .get(projectId) as ProjectSettings | undefined
}

export function upsertProjectSettings(input: {
  project_id: string
  theme_id?: string | null
  primary_color?: string | null
  accent_color?: string | null
  sidebar_color?: string | null
  logo_path?: string | null
  execution_provider?: string | null
  execution_provider_secondary?: string | null
  execution_provider_fallback?: string | null
  execution_model?: string | null
  execution_model_primary?: string | null
  execution_model_secondary?: string | null
  execution_model_fallback?: string | null
  fallback_policy?: string | null
  model_tier?: string | null
  monthly_cost_cap_usd?: number | null
  daily_cost_cap_usd?: number | null
}): void {
  const dbh = getDb()
  const keys = Object.keys(input).filter((key) => key !== 'project_id')
  if (keys.length === 0) {
    dbh.prepare(`INSERT INTO project_settings (project_id) VALUES (?) ON CONFLICT(project_id) DO NOTHING`).run(input.project_id)
    return
  }

  const columns = ['project_id', ...keys]
  const placeholders = columns.map(() => '?').join(', ')
  const updates = keys.map((key) => `${key} = excluded.${key}`).join(', ')
  const values = columns.map((key) => (input as Record<string, unknown>)[key] ?? null)

  dbh.prepare(
    `INSERT INTO project_settings (${columns.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT(project_id) DO UPDATE SET ${updates}`,
  ).run(...values)
}

// ---------------------------------------------------------------------------
// Chat-Project Mapping
// ---------------------------------------------------------------------------

export function getChatProject(chatKey: string, fallbackChatId?: string): string {
  const row = getDb()
    .prepare('SELECT project_id FROM chat_projects WHERE chat_id = ?')
    .get(chatKey) as { project_id: string } | undefined
  if (row?.project_id) return row.project_id
  if (fallbackChatId && fallbackChatId !== chatKey) {
    const legacyRow = getDb()
      .prepare('SELECT project_id FROM chat_projects WHERE chat_id = ?')
      .get(fallbackChatId) as { project_id: string } | undefined
    return legacyRow?.project_id ?? 'default'
  }
  return row?.project_id ?? 'default'
}

export function setChatProject(chatId: string, projectId: string): void {
  getDb()
    .prepare(
      `INSERT INTO chat_projects (chat_id, project_id)
       VALUES (?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET project_id = excluded.project_id`,
    )
    .run(chatId, projectId)
}

// ---------------------------------------------------------------------------
// Channel Log
// ---------------------------------------------------------------------------

export function logChannelMessage(entry: {
  direction: 'in' | 'out'
  channel: string
  channelName?: string
  botName?: string
  projectId?: string
  chatId: string
  senderName?: string
  agentId?: string
  content: string
  contentType?: string
  isVoice?: boolean
  isGroup?: boolean
  durationMs?: number
  tokensUsed?: number
  error?: string
}): void {
  try {
    getDb().prepare(
      `INSERT INTO channel_log (direction, channel, channel_name, bot_name, project_id, chat_id, sender_name, agent_id, content, content_type, is_voice, is_group, duration_ms, tokens_used, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.direction,
      entry.channel,
      entry.channelName ?? null,
      entry.botName ?? null,
      entry.projectId ?? null,
      entry.chatId,
      entry.senderName ?? null,
      entry.agentId ?? null,
      entry.content.slice(0, 2000),
      entry.contentType ?? 'text',
      entry.isVoice ? 1 : 0,
      entry.isGroup ? 1 : 0,
      entry.durationMs ?? null,
      entry.tokensUsed ?? null,
      entry.error ?? null,
      Date.now(),
    )
  } catch {
    // Don't let logging failures break message processing
  }
}

// ---------------------------------------------------------------------------
// Action items
// ---------------------------------------------------------------------------

export function insertActionItem(item: ActionItem): void {
  getDb().prepare(`
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
}

export function getActionItem(id: string): ActionItem | undefined {
  return getDb().prepare('SELECT * FROM action_items WHERE id = ?').get(id) as ActionItem | undefined
}

export function updateActionItemFields(id: string, fields: Partial<ActionItem>): number {
  const keys = Object.keys(fields)
  if (keys.length === 0) return 0
  const set = keys.map(k => `${k} = @${k}`).join(', ')
  const result = getDb().prepare(`UPDATE action_items SET ${set}, updated_at = @__updated_at WHERE id = @__id`)
    .run({ ...fields, __id: id, __updated_at: Date.now() })
  return result.changes
}

export function insertActionItemEvent(e: ActionItemEvent): void {
  getDb().prepare(`INSERT INTO action_item_events (id, item_id, actor, event_type, old_value, new_value, created_at)
              VALUES (@id, @item_id, @actor, @event_type, @old_value, @new_value, @created_at)`).run(e)
}

export function listActionItemEvents(itemId: string): ActionItemEvent[] {
  return getDb().prepare('SELECT * FROM action_item_events WHERE item_id = ? ORDER BY created_at ASC')
    .all(itemId) as ActionItemEvent[]
}

export function listActionItems(opts: {
  projectId?: string
  status?: ActionItemStatus | ActionItemStatus[]
  includeArchived?: boolean
} = {}): ActionItem[] {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.projectId) {
    where.push('project_id = ?')
    params.push(opts.projectId)
  }
  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status]
    where.push(`status IN (${statuses.map(() => '?').join(',')})`)
    params.push(...statuses)
  } else if (!opts.includeArchived) {
    where.push("status != 'archived'")
  }
  const sql = `SELECT * FROM action_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY
    CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
    COALESCE(target_date, 9999999999999),
    created_at DESC`
  return getDb().prepare(sql).all(...params) as ActionItem[]
}

export function insertActionItemComment(c: ActionItemComment): void {
  getDb().prepare(`INSERT INTO action_item_comments (id, item_id, author, body, created_at)
              VALUES (@id, @item_id, @author, @body, @created_at)`).run(c)
}

export function listActionItemComments(itemId: string): ActionItemComment[] {
  return getDb().prepare('SELECT * FROM action_item_comments WHERE item_id = ? ORDER BY created_at ASC')
    .all(itemId) as ActionItemComment[]
}

export function deleteActionItem(id: string): boolean {
  const tx = getDb().transaction((itemId: string) => {
    getDb().prepare('DELETE FROM action_item_comments WHERE item_id = ?').run(itemId)
    getDb().prepare('DELETE FROM action_item_events WHERE item_id = ?').run(itemId)
    const result = getDb().prepare('DELETE FROM action_items WHERE id = ?').run(itemId)
    return result.changes > 0
  })
  return tx(id)
}

export function purgeArchivedActionItems(cutoffMs: number): number {
  const tx = getDb().transaction((cutoff: number) => {
    const rows = getDb().prepare(`
      SELECT id FROM action_items
       WHERE archived_at IS NOT NULL
         AND archived_at < ?
    `).all(cutoff) as { id: string }[]
    if (rows.length === 0) return 0
    const delComments = getDb().prepare('DELETE FROM action_item_comments WHERE item_id = ?')
    const delEvents   = getDb().prepare('DELETE FROM action_item_events   WHERE item_id = ?')
    const delItem     = getDb().prepare('DELETE FROM action_items          WHERE id      = ?')
    for (const row of rows) {
      delComments.run(row.id)
      delEvents.run(row.id)
      delItem.run(row.id)
    }
    return rows.length
  })
  return tx(cutoffMs)
}

export function archiveStaleActionItems(cutoffMs: number): number {
  const now = Date.now()
  const tx = getDb().transaction((cutoff: number) => {
    const rows = getDb().prepare(`
      SELECT id, status FROM action_items
       WHERE status IN ('completed', 'rejected')
         AND archived_at IS NULL
         AND COALESCE(completed_at, updated_at) < ?
    `).all(cutoff) as { id: string; status: string }[]
    if (rows.length === 0) return 0
    const updateStmt = getDb().prepare(`
      UPDATE action_items
         SET status = 'archived', archived_at = ?, updated_at = ?
       WHERE id = ?
    `)
    const eventStmt = getDb().prepare(`
      INSERT INTO action_item_events (id, item_id, actor, event_type, old_value, new_value, created_at)
      VALUES (?, ?, 'system', 'archived', ?, 'archived', ?)
    `)
    for (const row of rows) {
      updateStmt.run(now, now, row.id)
      eventStmt.run(randomUUID(), row.id, row.status, now)
    }
    return rows.length
  })
  return tx(cutoffMs)
}

// ── Security findings helpers used by paw finding-action handlers ──

export interface SecurityFindingRow {
  id: string
  scanner_id: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  title: string
  description: string
  target: string
  auto_fixable: 0 | 1
  auto_fixed: 0 | 1
  fix_description: string | null
  status: 'open' | 'fixed' | 'acknowledged' | 'false-positive'
  first_seen: number
  last_seen: number
  resolved_at: number | null
  metadata: string
  project_id: string
}

export function getFinding(id: string): SecurityFindingRow | undefined {
  const db = getDb()
  return db.prepare('SELECT * FROM security_findings WHERE id = ?').get(id) as
    | SecurityFindingRow
    | undefined
}

export function updateFindingStatus(
  id: string,
  status: 'open' | 'fixed' | 'acknowledged' | 'false-positive',
): void {
  const db = getDb()
  // security_findings.resolved_at uses SECONDS (legacy convention, see CLAUDE.md)
  const resolvedAt = status === 'fixed' || status === 'acknowledged' ? Math.floor(Date.now() / 1000) : null
  db.prepare('UPDATE security_findings SET status = ?, resolved_at = ? WHERE id = ?')
    .run(status, resolvedAt, id)
}

/** Open findings for the scanner run that produced a given paw's latest cycle findings. */
export function getOpenFindingsByIds(ids: string[]): SecurityFindingRow[] {
  if (ids.length === 0) return []
  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(
    `SELECT * FROM security_findings WHERE id IN (${placeholders}) AND status = 'open'`,
  ).all(...ids) as SecurityFindingRow[]
}
