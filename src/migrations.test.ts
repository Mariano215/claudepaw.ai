import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { getCurrentSchemaVersion, runMigrations } from './migrations.js'
import { competitiveWatchPhaseInstructions } from './paws/competitive-watch.js'
import { msChannelPulsePhaseInstructions } from './paws/ms-channel-pulse.js'
import { msSocialCadencePhaseInstructions } from './paws/ms-social-cadence.js'
import { msTrendScannerPhaseInstructions } from './paws/ms-trend-scanner.js'

describe('runMigrations', () => {
  afterEach(() => {
    delete process.env.DB_PATH
  })

  it('updates ClaudePaw paws to concise action-oriented prompts', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE paws (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        cron TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        config TEXT NOT NULL DEFAULT '{}',
        next_run INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `)
    db.pragma('user_version = 3')
    const insert = db.prepare(
      `INSERT INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )

    insert.run(
      'ms-trend-scanner',
      'default',
      'YouTube Trend Scanner',
      'scout',
      '0 8 * * *',
      'active',
      JSON.stringify({ approval_threshold: 4, phase_instructions: { observe: 'old' } }),
      0,
      Date.now(),
    )
    insert.run(
      'ms-channel-pulse',
      'default',
      'Channel Pulse',
      'scout',
      '0 8 * * 1,4',
      'active',
      JSON.stringify({ approval_threshold: 4, phase_instructions: { observe: 'old' } }),
      0,
      Date.now(),
    )
    insert.run(
      'ms-social-cadence',
      'default',
      'Social Cadence Guard',
      'social',
      '0 7 * * *',
      'active',
      JSON.stringify({ approval_threshold: 2, phase_instructions: { observe: 'old' } }),
      0,
      Date.now(),
    )

    runMigrations(db)

    const trend = JSON.parse((db.prepare('SELECT config FROM paws WHERE id = ?').get('ms-trend-scanner') as { config: string }).config)
    const channel = JSON.parse((db.prepare('SELECT config FROM paws WHERE id = ?').get('ms-channel-pulse') as { config: string }).config)
    const cadence = JSON.parse((db.prepare('SELECT config FROM paws WHERE id = ?').get('ms-social-cadence') as { config: string }).config)

    expect(getCurrentSchemaVersion(db)).toBe(5)
    expect(trend.approval_threshold).toBe(5)
    expect(trend.phase_instructions).toEqual(msTrendScannerPhaseInstructions)
    expect(channel.approval_threshold).toBe(5)
    expect(channel.phase_instructions).toEqual(msChannelPulsePhaseInstructions)
    expect(cadence.approval_threshold).toBe(4)
    expect(cadence.phase_instructions).toEqual(msSocialCadencePhaseInstructions)
  })

  it('updates ms-social-cadence to use scheduled and published timestamps', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE paws (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        cron TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        config TEXT NOT NULL DEFAULT '{}',
        next_run INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `)
    db.pragma('user_version = 2')
    db.prepare(
      `INSERT INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'ms-social-cadence',
      'default',
      'Social Cadence Guard',
      'social',
      '0 7 * * *',
      'active',
      JSON.stringify({
        approval_threshold: 2,
        chat_id: '123456789',
        approval_timeout_sec: 300,
        phase_instructions: {
          observe: 'old observe',
          analyze: 'old analyze',
          act: 'old act',
          report: 'old report',
        },
      }),
      0,
      Date.now(),
    )

    runMigrations(db)

    const row = db.prepare('SELECT config FROM paws WHERE id = ?').get('ms-social-cadence') as { config: string }
    const config = JSON.parse(row.config) as {
      phase_instructions: typeof msSocialCadencePhaseInstructions
      approval_threshold: number
    }

    expect(getCurrentSchemaVersion(db)).toBe(5)
    expect(config.approval_threshold).toBe(4)
    expect(config.phase_instructions).toEqual(msSocialCadencePhaseInstructions)
  })

  it('updates cp-competitive-watch to use deterministic collector', () => {
    const db = new Database(':memory:')
    db.prepare(
      `CREATE TABLE paws (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        cron TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        config TEXT NOT NULL DEFAULT '{}',
        next_run INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
    ).run()
    db.pragma('user_version = 4')
    db.prepare(
      `INSERT INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'cp-competitive-watch',
      'default',
      'Competitive Watch',
      'sentinel',
      '0 9 * * *',
      'active',
      JSON.stringify({ approval_threshold: 3, phase_instructions: { observe: 'old observe' } }),
      0,
      Date.now(),
    )

    runMigrations(db)

    const row = db.prepare('SELECT config FROM paws WHERE id = ?').get('cp-competitive-watch') as { config: string }
    const config = JSON.parse(row.config) as {
      approval_threshold: number
      observe_collector: string
      observe_collector_args: { window_days: number }
      phase_instructions: typeof competitiveWatchPhaseInstructions
    }

    expect(getCurrentSchemaVersion(db)).toBe(5)
    expect(config.approval_threshold).toBe(3)
    expect(config.observe_collector).toBe('competitive-landscape')
    expect(config.observe_collector_args).toEqual({ window_days: 14 })
    expect(config.phase_instructions).toEqual(competitiveWatchPhaseInstructions)
  })

  it('leaves databases without cp-competitive-watch untouched by migration 5', () => {
    const db = new Database(':memory:')
    db.prepare(
      `CREATE TABLE paws (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        cron TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        config TEXT NOT NULL DEFAULT '{}',
        next_run INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
    ).run()
    db.pragma('user_version = 4')

    runMigrations(db)

    expect(getCurrentSchemaVersion(db)).toBe(5)
    const count = db.prepare('SELECT COUNT(*) AS n FROM paws').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('leaves databases without ms-social-cadence untouched', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE paws (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        cron TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        config TEXT NOT NULL DEFAULT '{}',
        next_run INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `)
    db.pragma('user_version = 2')

    runMigrations(db)

    expect(getCurrentSchemaVersion(db)).toBe(5)
    const row = db.prepare('SELECT COUNT(*) AS n FROM paws').get() as { n: number }
    expect(row.n).toBe(0)
  })
})
