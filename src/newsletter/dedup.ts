import Database from 'better-sqlite3'
import path from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import type { EditionRow } from './types.js'

let db: Database.Database

function getDb(): Database.Database {
  if (!db) {
    throw new Error(
      'Newsletter tables not initialized -- call createNewsletterTables() first',
    )
  }
  return db
}

export function createNewsletterTables(database?: Database.Database): void {
  if (database) {
    db = database
  } else {
    const dbPath = path.join(STORE_DIR, 'claudepaw.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
  }

  db.exec(`
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
  `)

  logger.info('Newsletter database tables initialized')
}

export function isSeenUrl(url: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM newsletter_seen_links WHERE url = ?')
    .get(url)
  return row !== undefined
}

export function markUrlsSeen(urls: string[], editionDate: string): void {
  const now = Date.now()
  const stmt = getDb().prepare(
    `INSERT OR IGNORE INTO newsletter_seen_links (url, sent_at, edition_date)
     VALUES (?, ?, ?)`,
  )
  const tx = getDb().transaction(() => {
    for (const url of urls) {
      stmt.run(url, now, editionDate)
    }
  })
  tx()
}

export function pruneOldLinks(retentionDays: number = 365): number {
  const cutoff = Date.now() - retentionDays * 86_400_000
  const info = getDb()
    .prepare('DELETE FROM newsletter_seen_links WHERE sent_at < ?')
    .run(cutoff)
  if (info.changes > 0) {
    logger.info({ pruned: info.changes }, 'Pruned old newsletter seen links')
  }
  return info.changes
}

export function filterSeenArticles<T extends { url: string }>(articles: T[]): T[] {
  return articles.filter((a) => !isSeenUrl(a.url))
}

export function recordEdition(edition: EditionRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO newsletter_editions
       (id, date, lookback_days, articles_cyber, articles_ai, articles_research,
        hero_path, html_bytes, sent_at, recipient)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      edition.id,
      edition.date,
      edition.lookback_days,
      edition.articles_cyber,
      edition.articles_ai,
      edition.articles_research,
      edition.hero_path,
      edition.html_bytes,
      edition.sent_at,
      edition.recipient,
    )
}

export function getRecentEditions(limit: number = 10): EditionRow[] {
  return getDb()
    .prepare('SELECT * FROM newsletter_editions ORDER BY date DESC LIMIT ?')
    .all(limit) as EditionRow[]
}
