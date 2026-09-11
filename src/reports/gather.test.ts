import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { gatherNeedsYou, gatherProjectActivity } from './gather.js'

const DAY = 86_400_000
let core: InstanceType<typeof Database>
let telemetry: InstanceType<typeof Database>

function seedCore(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE paws (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, agent_id TEXT, cron TEXT, status TEXT, config TEXT, next_run INTEGER, created_at INTEGER);
    CREATE TABLE paw_cycles (id TEXT PRIMARY KEY, paw_id TEXT, started_at INTEGER, phase TEXT, state TEXT, findings TEXT, actions_taken TEXT, report TEXT, completed_at INTEGER, error TEXT);
    CREATE TABLE action_items (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, status TEXT, priority TEXT, source TEXT, proposed_by TEXT, executable_by_agent INTEGER, created_at INTEGER, updated_at INTEGER, completed_at INTEGER, archived_at INTEGER);
    CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, project_id TEXT, schedule TEXT, status TEXT, last_run INTEGER, last_result TEXT);
  `)
}

beforeEach(() => {
  core = new Database(':memory:')
  telemetry = new Database(':memory:')
  seedCore(core)
  telemetry.exec(`CREATE TABLE agent_events (id TEXT PRIMARY KEY, project_id TEXT, total_cost_usd REAL, is_error INTEGER, agent_started_at INTEGER);`)
})

describe('gatherNeedsYou', () => {
  it('lists routines waiting on approval, anchoring the age on when the card was sent', () => {
    // Cycle started 2 days ago, but the approval card (state.approval_requested_at,
    // written by paws/engine.ts) went out only 3 hours ago. The age must reflect
    // when the user was actually asked, not when the cycle happened to start.
    const startedAt = Date.now() - 2 * DAY
    const approvalRequestedAt = Date.now() - 3 * 3600_000
    core.prepare("INSERT INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at) VALUES ('p1','trader','Retrain regime','analyst','0 10 * * 0','waiting_approval','{}',0,0)").run()
    core.prepare("INSERT INTO paw_cycles (id, paw_id, started_at, phase, state, findings, actions_taken, report, completed_at, error) VALUES ('c1','p1',?,'decide',?,'[]','[]',NULL,NULL,NULL)")
      .run(startedAt, JSON.stringify({ approval_requested_at: approvalRequestedAt }))

    const rows = gatherNeedsYou(core, 30 * DAY, 'http://dash')

    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('routine_approval')
    expect(rows[0].project_id).toBe('trader')
    expect(rows[0].url).toBe('http://dash/#paws')
    expect(rows[0].age_ms).toBeGreaterThan(2 * 3600_000)
    expect(rows[0].age_ms).toBeLessThan(DAY)
  })

  it('falls back to cycle start when approval_requested_at is missing', () => {
    const startedAt = Date.now() - 2 * DAY
    core.prepare("INSERT INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at) VALUES ('p1','trader','Retrain regime','analyst','0 10 * * 0','waiting_approval','{}',0,0)").run()
    core.prepare("INSERT INTO paw_cycles (id, paw_id, started_at, phase, state, findings, actions_taken, report, completed_at, error) VALUES ('c1','p1',?,'decide','{}','[]','[]',NULL,NULL,NULL)").run(startedAt)

    const rows = gatherNeedsYou(core, 30 * DAY, 'http://dash')

    expect(rows).toHaveLength(1)
    expect(rows[0].age_ms).toBeGreaterThan(DAY)
  })

  it('lists proposed cards inside the window and skips archived ones', () => {
    const now = Date.now()
    core.prepare("INSERT INTO action_items VALUES ('a1','default','Approve social.post','{}','proposed','high','social.post','social-cli',1,?,?,NULL,NULL)").run(now - DAY, now - DAY)
    core.prepare("INSERT INTO action_items VALUES ('a2','default','Old thing','{}','proposed','low','chat','agent',0,?,?,NULL,?)").run(now - 90 * DAY, now - 90 * DAY, now)

    const rows = gatherNeedsYou(core, 30 * DAY, 'http://dash')

    expect(rows.map(r => r.title)).toEqual(['Approve social.post'])
    expect(rows[0].kind).toBe('card')
  })

  it('returns an empty list when a table is missing rather than throwing', () => {
    const bare = new Database(':memory:')
    expect(gatherNeedsYou(bare, DAY, 'http://dash')).toEqual([])
  })
})

describe('gatherProjectActivity', () => {
  it('rolls up cycles, cron runs, cards and cost per project', () => {
    const now = Date.now()
    core.prepare("INSERT INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at) VALUES ('p1','trader','Analyst','analyst','0 19 * * *','active','{}',0,0)").run()
    core.prepare("INSERT INTO paw_cycles (id, paw_id, started_at, phase, state, findings, actions_taken, report, completed_at, error) VALUES ('c1','p1',?,'completed','{}','[]','[]','all good',?,NULL)").run(now - 3600_000, now - 3500_000)
    core.prepare("INSERT INTO paw_cycles (id, paw_id, started_at, phase, state, findings, actions_taken, report, completed_at, error) VALUES ('c2','p1',?,'failed','{}','[]','[]',NULL,?,'boom')").run(now - 7200_000, now - 7100_000)
    core.prepare("INSERT INTO scheduled_tasks VALUES ('t1','trader','0 9 * * *','active',?,'ok')").run(now - 1800_000)
    core.prepare("INSERT INTO action_items VALUES ('a1','trader','Card','{}','proposed','medium','x','y',1,?,?,NULL,NULL)").run(now - 1000, now - 1000)
    core.prepare("INSERT INTO action_items VALUES ('a2','trader','Done','{}','completed','medium','x','y',1,?,?,?,NULL)").run(now - 5000, now - 1000, now - 1000)
    telemetry.prepare("INSERT INTO agent_events VALUES ('e1','trader',0.42,0,?)").run(now - 1000)
    telemetry.prepare("INSERT INTO agent_events VALUES ('e2','trader',0.08,1,?)").run(now - 900)

    const rows = gatherProjectActivity(core, telemetry, 24 * 3600_000)
    const trader = rows.find(r => r.project_id === 'trader')!

    expect(trader.cycles).toBe(2)
    expect(trader.cron_tasks_run).toBe(1)
    expect(trader.cards_opened).toBe(2)
    expect(trader.cards_shipped).toBe(1)
    expect(trader.failures).toBe(2)
    expect(trader.cost_usd).toBeCloseTo(0.5, 2)
    expect(trader.note).toContain('cycle')
  })

  it('omits projects with no activity in the window', () => {
    expect(gatherProjectActivity(core, telemetry, 3600_000)).toEqual([])
  })
})
