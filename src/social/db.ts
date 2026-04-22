import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { SocialPost, DraftInput, PostStatus } from './types.js'

// ---------------------------------------------------------------------------
// Schema - called from initDatabase() in main db.ts
// ---------------------------------------------------------------------------

// Canonical set of platforms allowed in social_posts.platform. Edit here to extend.
const ALLOWED_PLATFORMS = ['linkedin', 'twitter', 'youtube', 'facebook', 'instagram'] as const
const PLATFORM_CHECK_LIST = ALLOWED_PLATFORMS.map((p) => `'${p}'`).join(', ')
const SOCIAL_POSTS_SCHEMA = `CREATE TABLE social_posts_new (
  id               TEXT NOT NULL PRIMARY KEY,
  platform         TEXT NOT NULL CHECK(platform IN (${PLATFORM_CHECK_LIST})),
  content          TEXT NOT NULL,
  media_url        TEXT,
  suggested_time   TEXT,
  cta              TEXT,
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK(status IN ('draft', 'approved', 'published', 'rejected', 'failed')),
  platform_post_id TEXT,
  platform_url     TEXT,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  published_at     INTEGER,
  scheduled_at     INTEGER,
  created_by       TEXT NOT NULL DEFAULT 'social',
  project_id       TEXT NOT NULL DEFAULT 'default'
)`
const SOCIAL_POSTS_COPY_SQL = `INSERT INTO social_posts_new
   (id, platform, content, media_url, suggested_time, cta, status,
    platform_post_id, platform_url, error, created_at, published_at,
    scheduled_at, created_by, project_id)
   SELECT id, platform, content, media_url, suggested_time, cta, status,
          platform_post_id, platform_url, error, created_at, published_at,
          scheduled_at, created_by, project_id
   FROM social_posts`

function runSql(db: Database.Database, sql: string): void {
  // Single-statement wrapper so we avoid multi-statement batching.
  db.prepare(sql).run()
}

export function initSocialTables(db: Database.Database): void {
  runSql(
    db,
    `CREATE TABLE IF NOT EXISTS social_posts (
      id               TEXT NOT NULL PRIMARY KEY,
      platform         TEXT NOT NULL CHECK(platform IN (${PLATFORM_CHECK_LIST})),
      content          TEXT NOT NULL,
      media_url        TEXT,
      suggested_time   TEXT,
      cta              TEXT,
      status           TEXT NOT NULL DEFAULT 'draft'
                       CHECK(status IN ('draft', 'approved', 'published', 'rejected', 'failed')),
      platform_post_id TEXT,
      platform_url     TEXT,
      error            TEXT,
      created_at       INTEGER NOT NULL,
      published_at     INTEGER,
      scheduled_at     INTEGER,
      created_by       TEXT NOT NULL DEFAULT 'social',
      project_id       TEXT NOT NULL DEFAULT 'default'
    )`,
  )
  runSql(db, 'CREATE INDEX IF NOT EXISTS idx_social_status ON social_posts(status)')
  runSql(db, 'CREATE INDEX IF NOT EXISTS idx_social_platform ON social_posts(platform)')

  // Migration: add project_id column to existing tables from v1 schema
  try {
    runSql(db, "ALTER TABLE social_posts ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default'")
  } catch (_e) { /* Column already exists */ }
  try {
    runSql(db, 'CREATE INDEX IF NOT EXISTS idx_social_project ON social_posts(project_id)')
  } catch (_e) { /* Index already exists */ }

  // Migration: add scheduled_at for auto-publish-on-schedule flow
  try {
    runSql(db, 'ALTER TABLE social_posts ADD COLUMN scheduled_at INTEGER')
  } catch (_e) { /* Column already exists */ }
  try {
    runSql(
      db,
      `CREATE INDEX IF NOT EXISTS idx_social_due
       ON social_posts(status, scheduled_at)
       WHERE scheduled_at IS NOT NULL`,
    )
  } catch (_e) { /* Index already exists */ }

  // Repair historical rows inserted through out-of-band SQL that omitted `id`.
  // SQLite permits NULL on non-INTEGER PRIMARY KEY columns unless NOT NULL is
  // explicit, so older schemas could silently accept corrupt rows.
  repairNullSocialPostIds(db)

  // Migration: widen platform CHECK constraint and tighten `id` nullability on
  // older tables. SQLite cannot ALTER either constraint in place, so rebuild.
  migrateSocialPostsSchema(db)
}

function repairNullSocialPostIds(db: Database.Database): void {
  const rows = db
    .prepare('SELECT rowid FROM social_posts WHERE id IS NULL')
    .all() as Array<{ rowid: number }>
  if (rows.length === 0) return

  const lookup = db.prepare('SELECT 1 FROM social_posts WHERE id = ? LIMIT 1')
  const update = db.prepare('UPDATE social_posts SET id = ? WHERE rowid = ? AND id IS NULL')

  const repair = db.transaction(() => {
    for (const row of rows) {
      let id = ''
      do {
        id = randomUUID().slice(0, 8)
      } while (lookup.get(id))
      update.run(id, row.rowid)
    }
  })

  repair()
}

function migrateSocialPostsSchema(db: Database.Database): void {
  const sqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='social_posts'")
    .get() as { sql: string } | undefined
  if (!sqlRow) return
  const allowsYoutube = sqlRow.sql.includes("'youtube'")
  const hasNotNullId = /\bid\s+TEXT\s+NOT\s+NULL\s+PRIMARY\s+KEY\b/i.test(sqlRow.sql)
  if (allowsYoutube && hasNotNullId) return

  const rebuild = db.transaction(() => {
    runSql(db, SOCIAL_POSTS_SCHEMA)
    runSql(db, SOCIAL_POSTS_COPY_SQL)
    runSql(db, 'DROP TABLE social_posts')
    runSql(db, 'ALTER TABLE social_posts_new RENAME TO social_posts')
    runSql(db, 'CREATE INDEX IF NOT EXISTS idx_social_status ON social_posts(status)')
    runSql(db, 'CREATE INDEX IF NOT EXISTS idx_social_platform ON social_posts(platform)')
    runSql(db, 'CREATE INDEX IF NOT EXISTS idx_social_project ON social_posts(project_id)')
    runSql(
      db,
      `CREATE INDEX IF NOT EXISTS idx_social_due
       ON social_posts(status, scheduled_at)
       WHERE scheduled_at IS NOT NULL`,
    )
  })

  try {
    rebuild()
  } catch (_e) {
    // If the migration fails (unexpected schema drift, locked DB, etc.) we
    // intentionally leave the existing table alone rather than crashing
    // startup. The draft flow will continue to reject new platforms until a
    // human intervenes — visible via the SqliteError path at draft time.
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

let _db: Database.Database

export function setSocialDb(db: Database.Database): void {
  _db = db
}

function getDb(): Database.Database {
  if (!_db) throw new Error('Social DB not initialized')
  return _db
}

export function createDraft(input: DraftInput): SocialPost {
  const id = randomUUID().slice(0, 8)
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO social_posts (id, platform, content, media_url, suggested_time, cta, status, created_at, created_by, project_id)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    )
    .run(
      id,
      input.platform,
      input.content,
      input.media_url ?? null,
      input.suggested_time ?? null,
      input.cta ?? null,
      now,
      input.created_by ?? 'social',
      input.project_id,
    )
  return getPost(id)!
}

export function getPost(id: string): SocialPost | undefined {
  return getDb()
    .prepare('SELECT * FROM social_posts WHERE id = ?')
    .get(id) as SocialPost | undefined
}

export function listPosts(status?: PostStatus, limit: number = 20): SocialPost[] {
  if (status) {
    return getDb()
      .prepare('SELECT * FROM social_posts WHERE status = ? ORDER BY created_at DESC LIMIT ?')
      .all(status, limit) as SocialPost[]
  }
  return getDb()
    .prepare('SELECT * FROM social_posts ORDER BY created_at DESC LIMIT ?')
    .all(limit) as SocialPost[]
}

export function listDrafts(): SocialPost[] {
  return listPosts('draft')
}

export function approvePost(id: string): boolean {
  const info = getDb()
    .prepare("UPDATE social_posts SET status = 'approved' WHERE id = ? AND status = 'draft'")
    .run(id)
  return info.changes > 0
}

export function rejectPost(id: string): boolean {
  const info = getDb()
    .prepare("UPDATE social_posts SET status = 'rejected' WHERE id = ? AND status IN ('draft', 'approved')")
    .run(id)
  return info.changes > 0
}

export function markPublished(
  id: string,
  platformPostId: string,
  platformUrl: string,
): boolean {
  const info = getDb()
    .prepare(
      `UPDATE social_posts
       SET status = 'published', platform_post_id = ?, platform_url = ?, published_at = ?
       WHERE id = ?`,
    )
    .run(platformPostId, platformUrl, Date.now(), id)
  return info.changes > 0
}

export function markFailed(id: string, error: string): boolean {
  const info = getDb()
    .prepare("UPDATE social_posts SET status = 'failed', error = ? WHERE id = ?")
    .run(error, id)
  return info.changes > 0
}

export function updateContent(id: string, content: string): boolean {
  const info = getDb()
    .prepare("UPDATE social_posts SET content = ? WHERE id = ? AND status IN ('draft', 'approved')")
    .run(content, id)
  return info.changes > 0
}

export interface ScheduledPostInput {
  platform: 'linkedin' | 'twitter'
  content: string
  media_url?: string | null
  cta?: string | null
  suggested_time?: string | null
  project_id: string
  scheduled_at: number
  created_by: string
}

export function createScheduledPost(input: ScheduledPostInput): SocialPost {
  const id = randomUUID().slice(0, 8)
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO social_posts
         (id, platform, content, media_url, suggested_time, cta,
          status, created_at, created_by, project_id, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.platform,
      input.content,
      input.media_url ?? null,
      input.suggested_time ?? null,
      input.cta ?? null,
      now,
      input.created_by,
      input.project_id,
      input.scheduled_at,
    )
  return getPost(id)!
}

export function listDueApproved(nowMs: number): SocialPost[] {
  return getDb()
    .prepare(
      `SELECT * FROM social_posts
       WHERE status = 'approved'
         AND scheduled_at IS NOT NULL
         AND scheduled_at <= ?
       ORDER BY scheduled_at ASC`,
    )
    .all(nowMs) as SocialPost[]
}

// Checks whether a YouTube video (by 11-char ID) has already been
// cross-posted to linkedin or twitter for the given project.
// Matches the video ID as a substring of `content` — safe because the
// 11-char YT ID space is sparse enough that collisions are negligible.
export function hasCrossPostForVideo(projectId: string, youtubeId: string): boolean {
  if (!/^[A-Za-z0-9_-]{11}$/.test(youtubeId)) return false
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) as n FROM social_posts
       WHERE project_id = ?
         AND platform IN ('linkedin', 'twitter')
         AND status = 'published'
         AND content LIKE ?`,
    )
    .get(projectId, `%${youtubeId}%`) as { n: number }
  return row.n > 0
}

export function getPostStats(): { drafts: number; published: number; rejected: number; failed: number } {
  const row = getDb()
    .prepare(
      `SELECT
        SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as drafts,
        SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) as published,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM social_posts`,
    )
    .get() as Record<string, number>
  return {
    drafts: row.drafts ?? 0,
    published: row.published ?? 0,
    rejected: row.rejected ?? 0,
    failed: row.failed ?? 0,
  }
}
