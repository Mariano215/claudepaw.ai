/**
 * Integration test: runs a full Paw cycle through the engine,
 * verifying the complete OBSERVE -> ANALYZE -> DECIDE -> ACT -> REPORT flow
 * with DB persistence, approval gating, and cycle resumption.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initPawsTables, createPaw, getCycle, getLatestCycle, listCycles, getPaw, updatePawNextRun, updatePawStatus } from '../db.js'
import { runPawCycle, resumePawCycle } from '../engine.js'
import type { PawConfig } from '../types.js'

let db: InstanceType<typeof Database>

const baseConfig: PawConfig = {
  approval_threshold: 4,
  chat_id: '123456789',
  approval_timeout_sec: 300,
}

const mockSend = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  db = new Database(':memory:')
  initPawsTables(db)
  vi.clearAllMocks()
})

afterEach(() => {
  db.close()
})

describe('full cycle integration', () => {
  it('completes a quiet cycle silently -- no ACT, no REPORT, no Telegram ping', async () => {
    // Regression test for the sentinel-patrol noise bug: monitoring paws
    // running every 4h were sending "All clear. Score 100/100, no changes"
    // messages on every cycle. Quiet cycles (no new findings, no actionable
    // decisions) should persist state and complete, but not run ACT or REPORT
    // and not send a Telegram notification.
    createPaw(db, {
      id: 'sentinel-patrol',
      project_id: 'default',
      name: 'Sentinel Security Patrol',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: baseConfig,
    })

    const mockAgent = vi.fn()
      .mockResolvedValueOnce({ text: 'Port scan complete. Found: port 80 (HTTP), port 443 (HTTPS). Both expected.' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'port-80', severity: 1, title: 'Port 80 open (expected)', detail: 'Standard HTTP', is_new: false },
          { id: 'port-443', severity: 1, title: 'Port 443 open (expected)', detail: 'Standard HTTPS', is_new: false },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [
          { finding_id: 'port-80', action: 'skip', reason: 'Expected, no action needed' },
          { finding_id: 'port-443', action: 'skip', reason: 'Expected, no action needed' },
        ],
        max_severity: 1,
      }) })

    const cycleId = await runPawCycle(db, 'sentinel-patrol', mockAgent, mockSend)

    // Cycle is still persisted and marked completed.
    const cycle = getCycle(db, cycleId)
    expect(cycle).toBeDefined()
    expect(cycle!.phase).toBe('completed')
    expect(cycle!.completed_at).toBeGreaterThan(0)
    expect(cycle!.error).toBeNull()

    // OBSERVE/ANALYZE/DECIDE state is persisted.
    expect(cycle!.state.observe_raw).toContain('Port scan complete')
    expect(cycle!.state.analysis).toBeTruthy()
    expect(cycle!.state.decisions).toHaveLength(2)
    expect(cycle!.state.approval_requested).toBe(false)

    // ACT was skipped.
    expect(cycle!.state.act_result).toBeNull()

    // Findings from ANALYZE are still persisted for the next cycle's context.
    expect(cycle!.findings).toHaveLength(2)
    expect(cycle!.findings[0].id).toBe('port-80')

    // REPORT was skipped.
    expect(cycle!.report).toBeNull()

    // Only 3 agent calls (OBSERVE, ANALYZE, DECIDE) -- ACT and REPORT never ran.
    expect(mockAgent).toHaveBeenCalledTimes(3)

    // No Telegram notification for a quiet cycle.
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('runs all 5 phases end-to-end when findings are new (meaningful cycle)', async () => {
    createPaw(db, {
      id: 'sentinel-patrol',
      project_id: 'default',
      name: 'Sentinel Security Patrol',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: baseConfig,
    })

    const mockAgent = vi.fn()
      .mockResolvedValueOnce({ text: 'Port scan complete. NEW finding: port 8080 now open.' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'port-8080', severity: 2, title: 'Port 8080 unexpectedly open', detail: 'Not in baseline', is_new: true },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'port-8080', action: 'act', reason: 'Investigate new listener' }],
        max_severity: 2,
      }) })
      .mockResolvedValueOnce({ text: 'ACT: Logged port 8080 for follow-up.' })
      .mockResolvedValueOnce({ text: 'New port 8080 detected and logged for review.' })

    const cycleId = await runPawCycle(db, 'sentinel-patrol', mockAgent, mockSend)

    const cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('completed')
    expect(cycle!.state.act_result).toContain('port 8080')
    expect(cycle!.report).toContain('port 8080')
    expect(mockAgent).toHaveBeenCalledTimes(5)
    expect(mockSend).toHaveBeenCalledWith('123456789', expect.stringContaining('Cycle complete'))
  })

  it('pauses at DECIDE for high severity, resumes on approval, completes cycle', async () => {
    createPaw(db, {
      id: 'sentinel-patrol',
      project_id: 'default',
      name: 'Sentinel Security Patrol',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: { ...baseConfig, approval_threshold: 3 },
    })

    const mockAgent = vi.fn()
      // Phase 1-3: OBSERVE, ANALYZE, DECIDE
      .mockResolvedValueOnce({ text: 'CRITICAL: Admin panel exposed at /admin with no auth' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'admin-exposed', severity: 5, title: 'Admin panel exposed', detail: '/admin accessible without auth', is_new: true },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'admin-exposed', action: 'escalate', reason: 'Critical exposure, needs immediate action' }],
        max_severity: 5,
      }) })

    // First call: cycle should pause at DECIDE
    const cycleId = await runPawCycle(db, 'sentinel-patrol', mockAgent, mockSend)

    let cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('decide')
    expect(cycle!.state.approval_requested).toBe(true)
    expect(cycle!.state.approval_granted).toBeNull()
    expect(cycle!.completed_at).toBeNull()

    // Verify approval message was sent via Telegram
    expect(mockSend).toHaveBeenCalledWith('123456789', expect.stringContaining('need your call'))
    expect(mockSend).toHaveBeenCalledWith('123456789', expect.stringContaining('Admin panel exposed'))

    // Now simulate user approving
    mockAgent
      .mockResolvedValueOnce({ text: 'ACT: Opened GitHub issue #42 for admin panel exposure. Added firewall rule.' })
      .mockResolvedValueOnce({ text: 'CRITICAL: Admin panel at /admin was exposed. Opened issue #42 and added temp firewall rule. Needs permanent fix.' })

    await resumePawCycle(db, cycleId, true, mockAgent, mockSend)

    cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('completed')
    expect(cycle!.state.approval_granted).toBe(true)
    expect(cycle!.state.act_result).toContain('GitHub issue #42')
    expect(cycle!.report).toContain('CRITICAL')
    expect(cycle!.completed_at).toBeGreaterThan(0)
  })

  it('skips ACT when user denies approval', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: { ...baseConfig, approval_threshold: 1 },
    })

    const mockAgent = vi.fn()
      .mockResolvedValueOnce({ text: 'OBSERVE: something' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [{ id: 'f1', severity: 3, title: 'Medium issue', detail: 'details', is_new: true }],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'f1', action: 'act', reason: 'Fix it' }],
        max_severity: 3,
      }) })

    const cycleId = await runPawCycle(db, 'test-paw', mockAgent, mockSend)
    expect(getCycle(db, cycleId)!.phase).toBe('decide')

    // User skips
    mockAgent.mockResolvedValueOnce({ text: 'ACT was skipped by operator. 1 medium finding logged for next cycle.' })

    await resumePawCycle(db, cycleId, false, mockAgent, mockSend)

    const cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('completed')
    expect(cycle!.state.approval_granted).toBe(false)
    expect(cycle!.state.act_result).toBeNull()
    expect(mockSend).toHaveBeenCalledWith('123456789', expect.stringContaining('ACT skipped'))
  })

  it('second cycle receives previous cycle findings as context', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: baseConfig,
    })

    // Cycle 1
    const mockAgent1 = vi.fn()
      .mockResolvedValueOnce({ text: 'OBSERVE: Found issue A' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [{ id: 'a', severity: 2, title: 'Issue A', detail: 'Details A', is_new: true }],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'a', action: 'act', reason: 'Handle it' }],
        max_severity: 2,
      }) })
      .mockResolvedValueOnce({ text: 'ACT: Fixed A' })
      .mockResolvedValueOnce({ text: 'Fixed 1 issue' })

    await runPawCycle(db, 'test-paw', mockAgent1, mockSend)

    // Cycle 2 -- agent should receive previous findings in OBSERVE prompt
    const mockAgent2 = vi.fn()
      .mockResolvedValueOnce({ text: 'OBSERVE: All clear' })
      .mockResolvedValueOnce({ text: JSON.stringify({ findings: [] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ decisions: [], max_severity: 0 }) })
      .mockResolvedValueOnce({ text: 'No actions needed' })
      .mockResolvedValueOnce({ text: 'All clear, previous Issue A resolved' })

    await runPawCycle(db, 'test-paw', mockAgent2, mockSend)

    // Verify the OBSERVE phase prompt included previous findings
    const observePrompt = mockAgent2.mock.calls[0][0]
    expect(observePrompt).toContain('Issue A')

    // Verify we have 2 cycles
    const cycles = listCycles(db, 'test-paw', 10)
    expect(cycles).toHaveLength(2)
  })

  it('handles agent returning non-JSON in ANALYZE gracefully', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: baseConfig,
    })

    const mockAgent = vi.fn()
      .mockResolvedValueOnce({ text: 'OBSERVE: some data' })
      .mockResolvedValueOnce({ text: 'This is not JSON, just a plain text analysis of the situation.' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'unstructured', action: 'skip', reason: 'Not actionable' }],
        max_severity: 2,
      }) })
      .mockResolvedValueOnce({ text: 'No action taken' })
      .mockResolvedValueOnce({ text: 'One unstructured finding, skipped' })

    const cycleId = await runPawCycle(db, 'test-paw', mockAgent, mockSend)

    const cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('completed')
    // Should have created an "unstructured" finding from the plain text
    expect(cycle!.findings).toHaveLength(1)
    expect(cycle!.findings[0].id).toBe('unstructured')
    expect(cycle!.findings[0].detail).toContain('plain text analysis')
  })

  it('pause and resume CLI operations work', () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: baseConfig,
    })

    let paw = getPaw(db, 'test-paw')
    expect(paw!.status).toBe('active')

    // Simulate CLI pause
    updatePawStatus(db, 'test-paw', 'paused')
    paw = getPaw(db, 'test-paw')
    expect(paw!.status).toBe('paused')

    // Simulate CLI resume
    updatePawStatus(db, 'test-paw', 'active')
    paw = getPaw(db, 'test-paw')
    expect(paw!.status).toBe('active')
  })
})
