import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSoakReport } from './soak-report.js'
import { PROJECT_ROOT } from '../src/config.js'

const DAY = 86_400_000
const NOW = 1_789_000_000_000
let core: InstanceType<typeof Database>
let telemetry: InstanceType<typeof Database>

beforeEach(() => {
  core = new Database(':memory:')
  telemetry = new Database(':memory:')
  core.exec(`
    CREATE TABLE paws (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, cron TEXT, status TEXT);
    CREATE TABLE paw_cycles (id TEXT PRIMARY KEY, paw_id TEXT, phase TEXT, started_at INTEGER, completed_at INTEGER, error TEXT, report TEXT);
    CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, project_id TEXT, schedule TEXT, status TEXT, last_run INTEGER, last_result TEXT);
    CREATE TABLE channel_log (id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT, channel TEXT, project_id TEXT, chat_id TEXT, content TEXT, created_at INTEGER);
  `)
  telemetry.exec(`CREATE TABLE error_log (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, subsystem TEXT, severity TEXT, message TEXT, recorded_at INTEGER)`)

  core.prepare("INSERT INTO paws VALUES ('p1','example-company','Festival','0 9 * * 2','active')").run()
  core.prepare("INSERT INTO paw_cycles VALUES ('c1','p1','completed',?,?,NULL,'a report')").run(NOW - 2 * DAY, NOW - 2 * DAY)
  core.prepare("INSERT INTO paw_cycles VALUES ('c2','p1','failed',?,?,'boom',NULL)").run(NOW - 3 * DAY, NOW - 3 * DAY)
  core.prepare("INSERT INTO paw_cycles VALUES ('c3','p1','completed',?,?,NULL,'old')").run(NOW - 40 * DAY, NOW - 40 * DAY)
  core.prepare("INSERT INTO scheduled_tasks VALUES ('t1','example-company','0 4 * * 1','active',?,'briefing done')").run(NOW - DAY)
  core.prepare("INSERT INTO scheduled_tasks VALUES ('t2','example-company','0 5 * * 1','active',?,'ERROR: token expired')").run(NOW - DAY)
  core.prepare("INSERT INTO channel_log (direction, channel, project_id, chat_id, content, created_at) VALUES ('out','telegram','example-company','1','line',?)").run(NOW - DAY)
  core.prepare("INSERT INTO channel_log (direction, channel, project_id, chat_id, content, created_at) VALUES ('in','telegram','example-company','1','reply',?)").run(NOW - DAY)
  telemetry.prepare("INSERT INTO error_log (project_id, subsystem, severity, message, recorded_at) VALUES ('example-company','scheduler','error','boom',?)").run(NOW - DAY)
})

describe('buildSoakReport', () => {
  it('counts cycles and failures inside the window only', () => {
    const r = buildSoakReport(core, telemetry, 14, NOW)
    const fo = r.projects.find(p => p.project_id === 'example-company')!
    expect(fo.cycles).toBe(2)
    expect(fo.cycle_failures).toBe(1)
  })

  it('counts a cron task whose last_result reads as an error', () => {
    const fo = buildSoakReport(core, telemetry, 14, NOW).projects.find(p => p.project_id === 'example-company')!
    expect(fo.cron_tasks_ran).toBe(2)
    expect(fo.cron_failures).toBe(1)
  })

  it('counts error_log rows and outbound messages per project, ignoring inbound', () => {
    const fo = buildSoakReport(core, telemetry, 14, NOW).projects.find(p => p.project_id === 'example-company')!
    expect(fo.errors).toBe(1)
    expect(fo.messages).toBe(1)
  })

  it('returns an empty report rather than throwing on a bare database', () => {
    const bare = new Database(':memory:')
    expect(buildSoakReport(bare, bare, 14, NOW).projects).toEqual([])
  })

  it('exits 2 with one line naming the path, instead of a raw SqliteError, when store/ is missing', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'soak-report-test-'))
    try {
      const script = join(PROJECT_ROOT, 'scripts', 'soak-report.ts')
      try {
        execFileSync('npx', ['tsx', script], { cwd: emptyDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
        expect.fail('expected the script to exit non-zero')
      } catch (err) {
        const e = err as { status?: number; stderr?: string }
        expect(e.status).toBe(2)
        expect(e.stderr).toContain('missing store file')
      }
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})
