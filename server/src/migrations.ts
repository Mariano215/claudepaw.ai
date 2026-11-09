// server/src/migrations.ts
// Versioned migration runner for the dashboard server database.
// Mirrors the bot-side pattern in src/migrations.ts using SQLite PRAGMA user_version.
//
// HOW TO ADD A NEW MIGRATION:
//   1. Add an entry to MIGRATIONS with the next version number.
//   2. The `up` function receives a live db handle -- use ALTER TABLE,
//      CREATE TABLE IF NOT EXISTS, etc.
//   3. Always make migrations additive and never destructive.
//   4. Never modify or reorder existing migration entries.
//
// All schema changes that existed before this module was introduced are
// considered "version 0" -- they are handled by the ad-hoc CREATE TABLE IF NOT
// EXISTS blocks and try/catch ALTER TABLE blocks in initDatabase(). Version 1
// is the starting point for tracked migrations.

import type Database from 'better-sqlite3'
import { logger } from './logger.js'
import { getAgentsForProject } from './agents.js'

interface Migration {
  version: number
  description: string
  up: (db: Database.Database) => void
}

export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === column)
}

export function hasTable(db: Database.Database, table: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(table) as { name: string } | undefined
  return !!row
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Baseline: acknowledge all pre-existing ad-hoc migrations',
    // No-op. All migrations before this point are handled by the CREATE TABLE
    // IF NOT EXISTS and try/catch ALTER TABLE blocks in initDatabase(). This
    // entry establishes version tracking so future migrations have a known
    // starting point.
    up: (_db) => {},
  },
  {
    version: 2,
    description: 'Remove stale agent rows whose template_id no longer exists in the project roster',
    // Context: some projects were lazy-seeded
    // from GENERIC_PROJECT_AGENTS (builder/scout/strategist/auditor/advocate)
    // before their real rosters existed in agents.ts. Once the real rosters
    // landed, those stale rows were left behind -- the dashboard kept showing
    // the generic 5 instead of the actual project agents.
    //
    // This migration drops any row whose (project_id, template_id) combination
    // is no longer in the roster returned by getAgentsForProject(). The
    // dashboard's existing lazy-seed path will repopulate the correct rows
    // the next time the project page loads.
    up: (db) => {
      const rows = db
        .prepare('SELECT project_id, id, template_id FROM agents')
        .all() as Array<{ project_id: string; id: string; template_id: string | null }>
      const rosterCache = new Map<string, Set<string>>()
      const deleteStmt = db.prepare('DELETE FROM agents WHERE id = ?')
      let removed = 0
      for (const row of rows) {
        if (!row.template_id) continue
        let allowed = rosterCache.get(row.project_id)
        if (!allowed) {
          allowed = new Set(getAgentsForProject(row.project_id).map((a) => a.id))
          rosterCache.set(row.project_id, allowed)
        }
        if (!allowed.has(row.template_id)) {
          deleteStmt.run(row.id)
          removed += 1
        }
      }
      if (removed > 0) {
        logger.info({ removed }, 'Pruned stale agent rows with no roster entry')
      }
    },
  },
]

export function getCurrentSchemaVersion(db: Database.Database): number {
  return (db.pragma('user_version', { simple: true }) as number) ?? 0
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.pragma(`user_version = ${version}`)
}

export function runServerMigrations(db: Database.Database): void {
  const currentVersion = getCurrentSchemaVersion(db)
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion)

  if (pending.length === 0) {
    logger.debug({ currentVersion }, 'Server DB schema up to date')
    return
  }

  logger.info(
    { currentVersion, pending: pending.length },
    'Running server DB migrations'
  )

  for (const migration of pending) {
    try {
      const applyMigration = db.transaction(() => {
        migration.up(db)
        setSchemaVersion(db, migration.version)
      })
      applyMigration()
      logger.info(
        { version: migration.version, description: migration.description },
        'Server migration applied'
      )
    } catch (err) {
      logger.error(
        { err, version: migration.version },
        'Server migration failed -- aborting'
      )
      throw err
    }
  }

  logger.info(
    { version: getCurrentSchemaVersion(db) },
    'Server migrations complete'
  )
}
