// src/paws/__tests__/engine.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initPawsTables, createPaw, getCycle, getLatestCycle } from '../db.js'
import { runPawCycle, resumePawCycle } from '../engine.js'
import type { PawConfig } from '../types.js'

let db: InstanceType<typeof Database>

const testConfig: PawConfig = {
  approval_threshold: 4,
  chat_id: '12345',
  approval_timeout_sec: 300,
}

const mockRunAgent = vi.fn()
const mockSend = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  db = new Database(':memory:')
  initPawsTables(db)
  vi.clearAllMocks()
})

afterEach(() => {
  db.close()
})

describe('runPawCycle', () => {
  it('runs all 5 phases for a low-severity cycle (no approval needed)', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: testConfig,
    })

    mockRunAgent
      .mockResolvedValueOnce({ text: 'OBSERVE: Found 2 open ports' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'f1', severity: 2, title: 'Open port 80', detail: 'HTTP open', is_new: true },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'f1', action: 'act', reason: 'Low sev, auto-handle' }],
        max_severity: 2,
      }) })
      .mockResolvedValueOnce({ text: 'ACT: Added to weekly digest' })
      .mockResolvedValueOnce({ text: 'REPORT: 1 low-severity finding handled automatically' })

    const cycleId = await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)

    const cycle = getCycle(db, cycleId)
    expect(cycle).toBeDefined()
    expect(cycle!.phase).toBe('completed')
    expect(cycle!.completed_at).toBeGreaterThan(0)
    expect(cycle!.error).toBeNull()
    expect(cycle!.report).toContain('REPORT:')
    expect(mockRunAgent).toHaveBeenCalledTimes(5)
  })

  it('pauses at DECIDE when severity exceeds threshold', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: { ...testConfig, approval_threshold: 3 },
    })

    mockRunAgent
      .mockResolvedValueOnce({ text: 'OBSERVE: Critical finding' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'f1', severity: 5, title: 'Exposed admin', detail: 'Admin panel public', is_new: true },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'f1', action: 'escalate', reason: 'Critical, needs approval' }],
        max_severity: 5,
      }) })

    const cycleId = await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)

    const cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('decide')
    expect(cycle!.state.approval_requested).toBe(true)
    expect(cycle!.state.approval_granted).toBeNull()
    expect(mockSend).toHaveBeenCalledWith('12345', expect.stringContaining('need your call'), expect.any(String))
  })

  it('skips ACT/REPORT and sends nothing on a quiet cycle (no findings, no decisions)', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: testConfig,
    })

    mockRunAgent
      .mockResolvedValueOnce({ text: 'OBSERVE: Score 100/100, 0 open findings' })
      .mockResolvedValueOnce({ text: JSON.stringify({ findings: [] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ decisions: [], max_severity: 0 }) })

    const cycleId = await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)

    const cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('completed')
    expect(cycle!.report).toBeNull()
    // Only the 3 early phases ran -- ACT and REPORT are skipped.
    expect(mockRunAgent).toHaveBeenCalledTimes(3)
    // No Telegram notification for quiet cycles.
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('skips ACT/REPORT when findings exist but are all known (is_new: false) with no actions', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: testConfig,
    })

    mockRunAgent
      .mockResolvedValueOnce({ text: 'OBSERVE: same 2 known open ports' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'f1', severity: 2, title: 'Port 80 open', detail: 'known', is_new: false },
          { id: 'f2', severity: 1, title: 'Port 443 open', detail: 'known', is_new: false },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [
          { finding_id: 'f1', action: 'skip', reason: 'already tracked' },
          { finding_id: 'f2', action: 'skip', reason: 'already tracked' },
        ],
        max_severity: 2,
      }) })

    const cycleId = await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)

    const cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('completed')
    expect(cycle!.report).toBeNull()
    expect(mockRunAgent).toHaveBeenCalledTimes(3)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('forces repeated findings to known when a prior cycle already surfaced them', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: testConfig,
    })

    mockRunAgent
      .mockResolvedValueOnce({ text: 'OBSERVE: first sighting' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'f-repeat', severity: 3, title: 'Competitor shipped SSE streaming', detail: 'First report', is_new: true },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'f-repeat', action: 'act', reason: 'track it' }],
        max_severity: 3,
      }) })
      .mockResolvedValueOnce({ text: 'ACT: logged it' })
      .mockResolvedValueOnce({ text: 'REPORT: surfaced once' })

    await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)

    vi.clearAllMocks()
    mockRunAgent
      .mockResolvedValueOnce({ text: 'OBSERVE: same thing again' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'f-repeat', severity: 3, title: 'Competitor shipped SSE streaming', detail: 'Repeated report', is_new: true },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'f-repeat', action: 'skip', reason: 'already tracked' }],
        max_severity: 3,
      }) })

    const cycleId = await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)

    const cycle = getCycle(db, cycleId)
    expect(cycle!.findings[0].is_new).toBe(false)
    expect(cycle!.phase).toBe('completed')
    expect(cycle!.report).toBeNull()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('allows a repeated finding to resurface when severity increases', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: { ...testConfig, approval_threshold: 5 },
    })

    mockRunAgent
      .mockResolvedValueOnce({ text: 'OBSERVE: moderate issue' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'f-escalate', severity: 2, title: 'Provider changed pricing policy', detail: 'Initial note', is_new: true },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'f-escalate', action: 'act', reason: 'track it' }],
        max_severity: 2,
      }) })
      .mockResolvedValueOnce({ text: 'ACT: recorded it' })
      .mockResolvedValueOnce({ text: 'REPORT: moderate issue recorded' })

    await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)

    vi.clearAllMocks()
    mockRunAgent
      .mockResolvedValueOnce({ text: 'OBSERVE: same issue got worse' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'f-escalate', severity: 4, title: 'Provider changed pricing policy', detail: 'Now blocking subscription credits', is_new: true },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'f-escalate', action: 'act', reason: 'severity increased' }],
        max_severity: 4,
      }) })
      .mockResolvedValueOnce({ text: 'ACT: escalated response' })
      .mockResolvedValueOnce({ text: 'REPORT: issue worsened' })

    const cycleId = await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)

    const cycle = getCycle(db, cycleId)
    expect(cycle!.findings[0].is_new).toBe(true)
    expect(cycle!.phase).toBe('completed')
    expect(mockSend).toHaveBeenCalledWith('12345', expect.stringContaining('Cycle complete'), expect.any(String))
  })

  it('does not request approval for repeated high-severity findings once dedupe marks them known', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: testConfig,
    })

    mockRunAgent
      .mockResolvedValueOnce({ text: 'OBSERVE: first sighting' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'f-repeat-high', severity: 5, title: 'Provider revoked key capability', detail: 'Initial report', is_new: true },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'f-repeat-high', action: 'escalate', reason: 'human review' }],
        max_severity: 5,
      }) })

    const firstCycleId = await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)
    const firstCycle = getCycle(db, firstCycleId)
    expect(firstCycle!.phase).toBe('decide')
    expect(firstCycle!.state.approval_requested).toBe(true)
    expect(mockSend).toHaveBeenCalledTimes(1)

    mockRunAgent.mockResolvedValueOnce({ text: 'REPORT: denied for now' })
    await resumePawCycle(db, firstCycleId, false, mockRunAgent, mockSend)

    vi.clearAllMocks()
    mockRunAgent
      .mockResolvedValueOnce({ text: 'OBSERVE: same thing again' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'f-repeat-high', severity: 5, title: 'Provider revoked key capability', detail: 'Repeated report', is_new: true },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'f-repeat-high', action: 'escalate', reason: 'model still thinks urgent' }],
        max_severity: 5,
      }) })

    const secondCycleId = await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)
    const secondCycle = getCycle(db, secondCycleId)
    expect(secondCycle!.findings[0].is_new).toBe(false)
    expect(secondCycle!.phase).toBe('completed')
    expect(secondCycle!.state.approval_requested).toBe(false)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('derives approval severity from findings instead of trusting decide.max_severity', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: testConfig,
    })

    mockRunAgent
      .mockResolvedValueOnce({ text: 'OBSERVE: minor issue' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'f-low', severity: 2, title: 'Minor issue', detail: 'Track it', is_new: true },
        ],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({
        decisions: [{ finding_id: 'f-low', action: 'act', reason: 'include in report' }],
        max_severity: 5,
      }) })
      .mockResolvedValueOnce({ text: 'ACT: logged it' })
      .mockResolvedValueOnce({ text: 'REPORT: tracked it' })

    const cycleId = await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)
    const cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('completed')
    expect(cycle!.state.approval_requested).toBe(false)
    expect(mockSend).toHaveBeenCalledWith('12345', expect.stringContaining('Cycle complete'), expect.any(String))
  })

  it('records error if a phase fails', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: testConfig,
    })

    mockRunAgent.mockRejectedValueOnce(new Error('Agent crashed'))

    const cycleId = await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)

    const cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('failed')
    expect(cycle!.error).toContain('Agent crashed')
  })

  it('records phase context when the agent throws before returning text', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: testConfig,
    })

    mockRunAgent.mockRejectedValueOnce(new Error('fetch failed'))

    const cycleId = await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)

    const cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('failed')
    expect(cycle!.error).toBe('OBSERVE phase failed: fetch failed')
  })

  it('records empty-result diagnostics for no-text phases', async () => {
    createPaw(db, {
      id: 'test-paw',
      project_id: 'default',
      name: 'Test Paw',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: testConfig,
    })

    mockRunAgent
      .mockResolvedValueOnce({ text: 'OBSERVE: Festival data gathered' })
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [
          { id: 'f1', severity: 3, title: 'Deadline soon', detail: 'Verify immediately', is_new: true },
        ],
      }) })
      .mockResolvedValueOnce({
        text: null,
        emptyReason: 'Agent finished successfully but produced an empty result (likely the model returned no text after using 2 tools). 1 turns, 9s.',
      })

    const cycleId = await runPawCycle(db, 'test-paw', mockRunAgent, mockSend)

    const cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('failed')
    expect(cycle!.error).toContain('Agent returned no text for decide phase')
    expect(cycle!.error).toContain('produced an empty result')
  })

  it('uses pawSend with a keyboard when maxSeverity >= threshold', async () => {
    createPaw(db, {
      id: 'sentinel-patrol',
      project_id: 'default',
      name: 'Sentinel Security Patrol',
      agent_id: 'auditor',
      cron: '0 */4 * * *',
      config: testConfig,
    })

    // OBSERVE -> returns raw
    mockRunAgent.mockResolvedValueOnce({ text: 'raw observation' })
    // ANALYZE -> returns findings JSON
    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify({
        findings: [
          { id: 'f1', severity: 4, title: 'NPM CVE', detail: 'bad', is_new: true },
        ],
      }),
    })
    // DECIDE -> returns decisions + max_severity that triggers approval
    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify({
        decisions: [{ finding_id: 'f1', action: 'act', reason: 'patch' }],
        max_severity: 4,
      }),
    })

    const pawSend = vi.fn().mockResolvedValue(undefined)
    await runPawCycle(db, 'sentinel-patrol', mockRunAgent, mockSend, undefined, pawSend)

    expect(pawSend).toHaveBeenCalledTimes(1)
    const [chatId, text, keyboard] = pawSend.mock.calls[0]
    expect(chatId).toBe('12345')
    expect(text).toContain('🛡 Sentinel Security Patrol')
    expect(text).toContain('ClaudePaw  •  1 finding')
    // Simplified keyboard: one row with Approve / Skip at cycle level
    expect(keyboard.inline_keyboard).toHaveLength(1)
    expect(keyboard.inline_keyboard[0][0].callback_data).toBe('paw:approve:sentinel-patrol')
    expect(keyboard.inline_keyboard[0][1].callback_data).toBe('paw:skip:sentinel-patrol')
  })
})
