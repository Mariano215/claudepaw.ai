// src/migrations.ts
// Versioned migration runner using SQLite PRAGMA user_version.
//
// HOW TO ADD A NEW MIGRATION:
//   1. Add an entry to MIGRATIONS with the next version number.
//   2. The `up` function receives a live db handle -- use ALTER TABLE,
//      CREATE TABLE IF NOT EXISTS, etc.
//   3. Always make migrations additive and never destructive.
//   4. Never modify or reorder existing migration entries.
//
// NOTE: All schema changes that existed before this module was introduced are
// considered "version 0" -- they are handled by the ad-hoc try/catch blocks
// in src/db.ts initDatabase(). Version 1 is the starting point for tracked
// migrations.

import type Database from 'better-sqlite3'
import { logger } from './logger.js'
import { msChannelPulsePhaseInstructions } from './paws/ms-channel-pulse.js'
import { msSocialCadencePhaseInstructions } from './paws/ms-social-cadence.js'
import { msTrendScannerPhaseInstructions } from './paws/ms-trend-scanner.js'

interface Migration {
  version: number
  description: string
  up: (db: Database.Database) => void
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Baseline: acknowledge all pre-existing ad-hoc migrations',
    // No-op. All migrations before this point are handled by the try/catch
    // ALTER TABLE blocks in initDatabase(). This entry establishes version
    // tracking so future migrations have a known starting point.
    up: (_db) => {},
  },
  {
    version: 2,
    description: "Add 'bot' to users.global_role CHECK constraint (table-rebuild)",
    // SQLite does not support modifying a CHECK constraint via ALTER TABLE.
    // We rebuild the table with the new constraint, copy all rows, drop the
    // old table, and rename the new one. Foreign keys are disabled during the
    // swap to avoid constraint errors while the old table still exists.
    // This migration is idempotent: if the constraint already allows 'bot'
    // (e.g. on a fresh DB created after this migration shipped) the up
    // function returns immediately without making any changes.
    up: (db) => {
      // Inspect the DDL stored in sqlite_master to determine whether 'bot'
      // is already present in the CHECK constraint.
      const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`)
        .get() as { sql: string } | undefined

      if (!row) return // users table does not exist yet -- nothing to migrate

      if (row.sql.includes("'bot'") || row.sql.includes('"bot"')) {
        return // constraint already covers 'bot' -- skip
      }

      // Rebuild the table to pick up the new CHECK constraint.
      // FK enforcement must be OFF during the swap so the references in
      // user_tokens and project_members do not fire against the
      // intermediate state where the old table is gone but the new one
      // is not yet renamed.
      db.pragma('foreign_keys = OFF')
      try {
        db.exec(`
          CREATE TABLE users_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            email        TEXT    NOT NULL UNIQUE,
            name         TEXT    NOT NULL,
            global_role  TEXT    NOT NULL DEFAULT 'member'
                          CHECK (global_role IN ('admin','member','bot')),
            created_at   INTEGER NOT NULL,
            last_seen_at INTEGER
          );

          INSERT INTO users_new (id, email, name, global_role, created_at, last_seen_at)
          SELECT id, email, name, global_role, created_at, last_seen_at FROM users;

          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
        `)
      } finally {
        db.pragma('foreign_keys = ON')
      }
    },
  },
  {
    version: 3,
    description: 'Correct Social Cadence Guard to evaluate scheduled and published social state',
    up: (db) => {
      const row = db
        .prepare(`SELECT config FROM paws WHERE id = 'ms-social-cadence'`)
        .get() as { config: string } | undefined

      if (!row) return

      let config: Record<string, unknown> = {}
      try {
        config = JSON.parse(row.config) as Record<string, unknown>
      } catch {
        config = {}
      }

      const nextConfig = {
        ...config,
        phase_instructions: {
          ...(typeof config.phase_instructions === 'object' && config.phase_instructions !== null
            ? config.phase_instructions as Record<string, unknown>
            : {}),
          ...msSocialCadencePhaseInstructions,
        },
      }

      db.prepare(`UPDATE paws SET config = ? WHERE id = 'ms-social-cadence'`).run(JSON.stringify(nextConfig))
    },
  },
  {
    version: 4,
    description: 'Tighten ClaudePaw Scout/Social paws for concise action-oriented output',
    up: (db) => {
      const updatePaw = (
        pawId: string,
        approvalThreshold: number,
        phaseInstructions: Record<string, unknown>,
      ) => {
        const row = db
          .prepare(`SELECT config FROM paws WHERE id = ?`)
          .get(pawId) as { config: string } | undefined

        if (!row) return

        let config: Record<string, unknown> = {}
        try {
          config = JSON.parse(row.config) as Record<string, unknown>
        } catch {
          config = {}
        }

        const nextConfig = {
          ...config,
          approval_threshold: approvalThreshold,
          phase_instructions: {
            ...(typeof config.phase_instructions === 'object' && config.phase_instructions !== null
              ? config.phase_instructions as Record<string, unknown>
              : {}),
            ...phaseInstructions,
          },
        }

        db.prepare(`UPDATE paws SET config = ? WHERE id = ?`).run(JSON.stringify(nextConfig), pawId)
      }

      updatePaw('ms-trend-scanner', 5, msTrendScannerPhaseInstructions)
      updatePaw('ms-channel-pulse', 5, msChannelPulsePhaseInstructions)
      updatePaw('ms-social-cadence', 4, msSocialCadencePhaseInstructions)
    },
  },
  // Add future migrations here:
  // {
  //   version: 3,
  //   description: 'Add foo column to bar table',
  //   up: (db) => {
  //     if (!hasColumn(db, 'bar', 'foo')) {
  //       db.prepare('ALTER TABLE bar ADD COLUMN foo TEXT').run()
  //     }
  //   },
  // },
]

export function getCurrentSchemaVersion(db: Database.Database): number {
  return (db.pragma('user_version', { simple: true }) as number) ?? 0
}

function setSchemaVersion(db: Database.Database, version: number): void {
  // user_version must be set via pragma statement, not bind parameters
  db.pragma(`user_version = ${version}`)
}

// Exported for use in migrations if needed
export function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === column)
}

export function runMigrations(db: Database.Database): void {
  const currentVersion = getCurrentSchemaVersion(db)
  const pending = MIGRATIONS.filter((m) => m.version > currentVersion)

  if (pending.length === 0) return

  logger.info({ currentVersion, pending: pending.length }, 'Running DB migrations')

  for (const migration of pending) {
    try {
      const applyMigration = db.transaction(() => {
        migration.up(db)
        setSchemaVersion(db, migration.version)
      })
      applyMigration()
      logger.info({ version: migration.version, description: migration.description }, 'Migration applied')
    } catch (err) {
      logger.error({ err, version: migration.version }, 'Migration failed -- aborting')
      throw err
    }
  }

  logger.info({ version: getCurrentSchemaVersion(db) }, 'Migrations complete')
}
