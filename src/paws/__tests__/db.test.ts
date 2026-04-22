// src/paws/__tests__/db.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initPawsTables, createPaw, getPaw, listPaws, updatePawStatus, updatePawNextRun, deletePaw, createCycle, updateCycle, getCycle, listCycles, getLatestCycle, reapStalePawCycles } from '../db.js'
import type { PawConfig, PawCycleState } from '../types.js'

let db: InstanceType<typeof Database>

const testConfig: PawConfig = {
  approval_threshold: 4,
  chat_id: '12345',
  approval_timeout_sec: 300,
}

const emptyCycleState: PawCycleState = {
  observe_raw: null,
  analysis: null,
  decisions: null,
  approval_requested: false,
  approval_granted: null,
  act_result: null,
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-22T09:00:00-04:00'))
  db = new Database(':memory:')
  initPawsTables(db)
})

afterEach(() => {
  db.close()
  vi.useRealTimers()
})

describe('paws table', () => {
  it('creates and retrieves a paw', () => {
    createPaw(db, {
      id: 'sentinel-patrol',
      project_id: 'default',
      name: 'Sentinel Security Patrol',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: testConfig,
    })
    const paw = getPaw(db, 'sentinel-patrol')
    expect(paw).toBeDefined()
    expect(paw!.id).toBe('sentinel-patrol')
    expect(paw!.agent_id).toBe('auditor')
    expect(paw!.status).toBe('active')
    expect(paw!.config).toEqual(testConfig)
  })

  it('lists paws by project', () => {
    createPaw(db, { id: 'p1', project_id: 'default', name: 'P1', agent_id: 'a', cron: '* * * * *', config: testConfig })
    createPaw(db, { id: 'p2', project_id: 'other', name: 'P2', agent_id: 'b', cron: '* * * * *', config: testConfig })
    expect(listPaws(db, 'default')).toHaveLength(1)
    expect(listPaws(db)).toHaveLength(2)
  })

  it('updates status', () => {
    createPaw(db, { id: 'p1', project_id: 'default', name: 'P1', agent_id: 'a', cron: '* * * * *', config: testConfig })
    updatePawStatus(db, 'p1', 'paused')
    expect(getPaw(db, 'p1')!.status).toBe('paused')
  })

  it('deletes a paw', () => {
    createPaw(db, { id: 'p1', project_id: 'default', name: 'P1', agent_id: 'a', cron: '* * * * *', config: testConfig })
    deletePaw(db, 'p1')
    expect(getPaw(db, 'p1')).toBeUndefined()
  })
})

describe('paw_cycles table', () => {
  it('creates and retrieves a cycle', () => {
    createPaw(db, { id: 'p1', project_id: 'default', name: 'P1', agent_id: 'a', cron: '* * * * *', config: testConfig })
    const cycleId = createCycle(db, 'p1')
    const cycle = getCycle(db, cycleId)
    expect(cycle).toBeDefined()
    expect(cycle!.paw_id).toBe('p1')
    expect(cycle!.phase).toBe('observe')
    expect(cycle!.state).toEqual(emptyCycleState)
  })

  it('updates cycle phase and state', () => {
    createPaw(db, { id: 'p1', project_id: 'default', name: 'P1', agent_id: 'a', cron: '* * * * *', config: testConfig })
    const cycleId = createCycle(db, 'p1')
    updateCycle(db, cycleId, {
      phase: 'analyze',
      state: { ...emptyCycleState, observe_raw: 'scan results here' },
    })
    const cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('analyze')
    expect(cycle!.state.observe_raw).toBe('scan results here')
  })

  it('lists cycles for a paw, newest first', () => {
    createPaw(db, { id: 'p1', project_id: 'default', name: 'P1', agent_id: 'a', cron: '* * * * *', config: testConfig })
    createCycle(db, 'p1')
    createCycle(db, 'p1')
    const cycles = listCycles(db, 'p1', 10)
    expect(cycles).toHaveLength(2)
    expect(cycles[0].started_at).toBeGreaterThanOrEqual(cycles[1].started_at)
  })

  it('gets latest cycle', () => {
    createPaw(db, { id: 'p1', project_id: 'default', name: 'P1', agent_id: 'a', cron: '* * * * *', config: testConfig })
    createCycle(db, 'p1')
    const c2 = createCycle(db, 'p1')
    const latest = getLatestCycle(db, 'p1')
    expect(latest!.id).toBe(c2)
  })

  it('unsticks timed-out approvals without forcing an immediate rerun', () => {
    createPaw(db, {
      id: 'p1',
      project_id: 'default',
      name: 'P1',
      agent_id: 'a',
      cron: '0 9 * * *',
      config: testConfig,
    })

    const cycleId = createCycle(db, 'p1')
    updatePawStatus(db, 'p1', 'waiting_approval')
    updatePawNextRun(db, 'p1', Date.now() - 60_000)
    updateCycle(db, cycleId, { phase: 'decide' })
    db.prepare('UPDATE paw_cycles SET started_at = ? WHERE id = ?').run(Date.now() - 10 * 60 * 1000, cycleId)

    const reaped = reapStalePawCycles(db)

    expect(reaped.pawsUnstuck).toBe(1)
    expect(getPaw(db, 'p1')!.status).toBe('active')
    expect(getPaw(db, 'p1')!.next_run).toBeGreaterThan(Date.now())

    const cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('failed')
    expect(cycle!.error).toBe('approval timeout — user did not respond')
  })
})
