// src/repo-events.ts
//
// The Paw Dev history log. One row per thing that happened to a repo, written
// by the collector-driven handlers, read by the History page and by the REPORT
// renderer. `docs/paw-dev/HISTORY.md` is an export of this table, never the
// source (.reviews/loop1-pawdev.md section 4).
//
// Timestamps are milliseconds, like everything else in ClaudePaw.

import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'
import { logger } from './logger.js'
import { DASHBOARD_URL, BOT_API_TOKEN, DASHBOARD_API_TOKEN } from './config.js'

export type RepoEventKind =
  | 'issue_opened' | 'issue_closed' | 'pr_opened' | 'pr_merged'
  | 'ci_failed' | 'ci_fixed' | 'mirror_synced' | 'reply_posted'

export interface RepoEvent {
  id: string
  repo: string
  kind: RepoEventKind
  ref: string | null
  actor: string
  item_id: string | null
  created_at: number
}

export interface RepoEventInput {
  repo: string
  kind: RepoEventKind
  ref?: string | null
  actor: string
  item_id?: string | null
  created_at?: number
}

export const REPO_EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS repo_events (
    id          TEXT PRIMARY KEY,
    repo        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    ref         TEXT,
    actor       TEXT NOT NULL,
    item_id     TEXT,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_repo_events_repo_time ON repo_events(repo, created_at);
`

export function writeRepoEvent(input: RepoEventInput): string {
  const id = randomUUID()
  const row: RepoEvent = {
    id,
    repo: input.repo,
    kind: input.kind,
    ref: input.ref ?? null,
    actor: input.actor,
    item_id: input.item_id ?? null,
    created_at: input.created_at ?? Date.now(),
  }
  getDb().prepare(
    `INSERT INTO repo_events (id, repo, kind, ref, actor, item_id, created_at)
     VALUES (@id, @repo, @kind, @ref, @actor, @item_id, @created_at)`,
  ).run(row)
  void mirrorToServer(row)
  return id
}

export function listRepoEvents(opts: { repo?: string; sinceMs?: number; limit?: number } = {}): RepoEvent[] {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.repo) { where.push('repo = ?'); params.push(opts.repo) }
  if (typeof opts.sinceMs === 'number') { where.push('created_at >= ?'); params.push(opts.sinceMs) }
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000)
  return getDb().prepare(
    `SELECT * FROM repo_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(...params, limit) as RepoEvent[]
}

/**
 * Grouped counts for the History page. `external` means a person who is not
 * the owner and not the bot. Everything else is `self`. Spec 6.4: the two are
 * counted apart so an agent filing its own issues cannot look like traction.
 */
export function repoEventStats(sinceMs: number): Array<{ repo: string; kind: string; actor_class: 'external' | 'self'; n: number }> {
  return getDb().prepare(
    `SELECT repo, kind,
            CASE WHEN actor LIKE 'external:%' THEN 'external' ELSE 'self' END AS actor_class,
            COUNT(*) AS n
       FROM repo_events
      WHERE created_at >= ?
      GROUP BY repo, kind, actor_class
      ORDER BY repo, kind`,
  ).all(sinceMs) as Array<{ repo: string; kind: string; actor_class: 'external' | 'self'; n: number }>
}

// Mirror to the dashboard DB, same fire-and-forget shape as
// src/remediations/db.ts:81-108. Losing a mirror write is never fatal.
async function mirrorToServer(row: RepoEvent): Promise<void> {
  if (!DASHBOARD_URL) return
  const token = BOT_API_TOKEN || DASHBOARD_API_TOKEN
  if (!token) return
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/v1/internal/repo-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-token': token },
      body: JSON.stringify({ rows: [row] }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) logger.debug({ status: res.status, id: row.id }, '[repo-events] server sync non-200')
  } catch (err) {
    logger.debug({ err, id: row.id }, '[repo-events] server sync failed')
  }
}
