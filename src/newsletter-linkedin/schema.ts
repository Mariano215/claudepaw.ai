import type Database from 'better-sqlite3'
import { logger } from '../logger.js'

/**
 * SQLite schema for the LinkedIn publishing pipeline. Tables live in the
 * main bot DB (`store/claudepaw.db`) alongside `newsletter_editions`.
 *
 * `linkedin_editions` is a queue: rows enter `pending_approval`, become
 * `approved` when the operator taps Approve, transition through `publishing`,
 * and land on `published` | `failed` | `skipped`.
 */

export function createLinkedinTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS linkedin_editions (
      id                    TEXT PRIMARY KEY,
      edition_date          TEXT NOT NULL,
      title                 TEXT NOT NULL,
      cover_path            TEXT NOT NULL,
      body_md               TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'pending_approval'
                                CHECK(status IN (
                                  'pending_approval', 'approved', 'publishing',
                                  'published', 'failed', 'skipped'
                                )),
      approval_chat_msg_id  INTEGER,
      created_at_ms         INTEGER NOT NULL,
      approved_at_ms        INTEGER,
      published_at_ms       INTEGER,
      published_url         TEXT,
      error_message         TEXT,
      attempts              INTEGER NOT NULL DEFAULT 0,
      last_screenshot       TEXT,
      dry_run               INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_linkedin_editions_status
      ON linkedin_editions(status);
    CREATE INDEX IF NOT EXISTS idx_linkedin_editions_date
      ON linkedin_editions(edition_date DESC);
  `)
  logger.info('LinkedIn editions schema initialized')
}
