// src/paws/__tests__/engine.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initPawsTables, createPaw, getCycle, getLatestCycle } from '../db.js'
import { runPawCycle, resumePawCycle } from '../engine.js'
import { __setProjectLookupForTests } from '../project-name.js'
import { registerCollector } from '../collectors/index.js'
import { registerHandler } from '../handlers/index.js'
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
  it('skip_if_unchanged: identical collector output completes the cycle without ANALYZE', async () => {
    registerCollector('static-test', async () => ({
      collector: 'static-test',
      collected_at: Date.now(),
      raw_data: { open: 1, fingerprint: 'abc' },
    }))
    createPaw(db, {
      id: 'static-paw',
      project_id: 'default',
      name: 'Static Paw',
      agent_id: 'auditor',
      cron: '0 9 * * *',
      config: { ...testConfig, observe_collector: 'static-test', skip_if_unchanged: true },
    })
    // First cycle: collector runs, ANALYZE and DECIDE run and find nothing.
    mockRunAgent
      .mockResolvedValueOnce({ text: JSON.stringify({ findings: [] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ decisions: [], max_severity: 0 }) })
    const first = await runPawCycle(db, 'static-paw', mockRunAgent, mockSend)
    expect(getCycle(db, first)!.phase).toBe('completed')
    const callsAfterFirst = mockRunAgent.mock.calls.length

    // Second cycle: same collector output, so no LLM call at all.
    const second = await runPawCycle(db, 'static-paw', mockRunAgent, mockSend)

    expect(mockRunAgent.mock.calls.length).toBe(callsAfterFirst)
    expect(getCycle(db, second)!.phase).toBe('completed')
    expect(getCycle(db, second)!.report).toBeNull()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('skip_if_unchanged: a skipped cycle carries forward the previous cycle findings for dedupe', async () => {
    registerCollector('static-test-findings', async () => ({
      collector: 'static-test-findings',
      collected_at: Date.now(),
      raw_data: { open: 1, fingerprint: 'abc' },
    }))
    createPaw(db, {
      id: 'static-paw-findings',
      project_id: 'default',
      name: 'Static Paw Findings',
      agent_id: 'auditor',
      cron: '0 9 * * *',
      config: { ...testConfig, observe_collector: 'static-test-findings', skip_if_unchanged: true },
    })

    // First cycle: ANALYZE reports f1 as new (below the approval threshold),
    // so DECIDE, ACT and REPORT all still run.
    mockRunAgent
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [{ id: 'f1', severity: 2, title: 'Open port 80', detail: 'HTTP open', is_new: true }],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ decisions: [], max_severity: 2 }) })
      .mockResolvedValueOnce({ text: 'ACT: noted' })
      .mockResolvedValueOnce({ text: 'REPORT: noted' })
    const first = await runPawCycle(db, 'static-paw-findings', mockRunAgent, mockSend)
    expect(getCycle(db, first)!.phase).toBe('completed')
    expect(getCycle(db, first)!.findings).toEqual([
      expect.objectContaining({ id: 'f1', is_new: true }),
    ])
    const callsAfterFirst = mockRunAgent.mock.calls.length

    // Second cycle: same collector output, skipped before any LLM call.
    const second = await runPawCycle(db, 'static-paw-findings', mockRunAgent, mockSend)
    expect(mockRunAgent.mock.calls.length).toBe(callsAfterFirst)
    expect(getCycle(db, second)!.phase).toBe('completed')
    // The skipped cycle must still carry f1 forward so dedupe history does
    // not go blind after a run of skipped cycles.
    expect(getCycle(db, second)!.findings).toEqual([
      expect.objectContaining({ id: 'f1', is_new: true }),
    ])

    // Third cycle: collector output changes, ANALYZE re-emits f1 as "new"
    // again. Dedupe must still see it via the skipped cycle's carried
    // findings and force it back to known.
    registerCollector('static-test-findings', async () => ({
      collector: 'static-test-findings',
      collected_at: Date.now(),
      raw_data: { open: 2, fingerprint: 'def' },
    }))
    // Dedupe forces f1 back to known before the meaningful-work check, so
    // the cycle stays quiet: no ACT/REPORT calls needed here either.
    mockRunAgent
      .mockResolvedValueOnce({ text: JSON.stringify({
        findings: [{ id: 'f1', severity: 2, title: 'Open port 80', detail: 'HTTP open', is_new: true }],
      }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ decisions: [], max_severity: 2 }) })
    const third = await runPawCycle(db, 'static-paw-findings', mockRunAgent, mockSend)
    expect(getCycle(db, third)!.findings).toEqual([
      expect.objectContaining({ id: 'f1', is_new: false }),
    ])
  })

  it('skip_if_unchanged: does not skip after a failed cycle, even with identical collector output', async () => {
    registerCollector('static-test-fail', async () => ({
      collector: 'static-test-fail',
      collected_at: Date.now(),
      raw_data: { open: 1, fingerprint: 'abc' },
    }))
    createPaw(db, {
      id: 'static-paw-fail',
      project_id: 'default',
      name: 'Static Paw Fail',
      agent_id: 'auditor',
      cron: '0 9 * * *',
      config: { ...testConfig, observe_collector: 'static-test-fail', skip_if_unchanged: true },
    })

    // First cycle: ANALYZE rejects, cycle ends up 'failed' but its state still
    // carries the observe_fingerprint written before the ANALYZE call.
    mockRunAgent.mockRejectedValueOnce(new Error('analyze boom'))
    const first = await runPawCycle(db, 'static-paw-fail', mockRunAgent, mockSend)
    expect(getCycle(db, first)!.phase).toBe('failed')
    const callsAfterFirst = mockRunAgent.mock.calls.length

    // Second cycle: same collector output as the failed cycle. Must NOT be
    // treated as "unchanged since last success" -- the LLM should run again
    // (findings=[] / decisions=[] hits the existing quiet-cycle short-circuit
    // after ANALYZE+DECIDE run, so report stays null; the point here is that
    // ANALYZE/DECIDE were actually invoked instead of the cycle being
    // silently marked completed by the skip guard before any LLM call).
    mockRunAgent
      .mockResolvedValueOnce({ text: JSON.stringify({ findings: [] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ decisions: [], max_severity: 0 }) })
    const second = await runPawCycle(db, 'static-paw-fail', mockRunAgent, mockSend)

    expect(mockRunAgent.mock.calls.length).toBe(callsAfterFirst + 2)
    expect(getCycle(db, second)!.phase).toBe('completed')
  })

  it('times out a collector that never resolves instead of stalling the cycle', async () => {
    vi.useFakeTimers()
    try {
      registerCollector('hanging-collector', () => new Promise(() => { /* never resolves */ }))
      createPaw(db, {
        id: 'hanging-paw',
        project_id: 'default',
        name: 'Hanging Paw',
        agent_id: 'auditor',
        cron: '0 9 * * *',
        config: { ...testConfig, observe_collector: 'hanging-collector' },
      })
      mockRunAgent
        .mockResolvedValueOnce({ text: JSON.stringify({ findings: [] }) })
        .mockResolvedValueOnce({ text: JSON.stringify({ decisions: [], max_severity: 0 }) })

      const cyclePromise = runPawCycle(db, 'hanging-paw', mockRunAgent, mockSend)
      await vi.advanceTimersByTimeAsync(120_000)
      const cycleId = await cyclePromise

      expect(getCycle(db, cycleId)!.phase).toBe('completed')
      expect(String(mockRunAgent.mock.calls[0][0])).toContain('collector timeout')
    } finally {
      vi.useRealTimers()
    }
  })

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
    expect(mockSend).toHaveBeenCalledWith('12345', expect.stringContaining('need approval'), expect.any(String))
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
    expect(mockSend).toHaveBeenCalledWith('12345', expect.stringContaining('REPORT:'), expect.any(String))
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
    expect(mockSend).toHaveBeenCalledWith('12345', expect.stringContaining('REPORT:'), expect.any(String))
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
    expect(text).toContain('Sentinel Security Patrol')
    expect(text).toContain('1 item need approval')
    // Simplified keyboard: one row with Approve / Reject at cycle level
    expect(keyboard.inline_keyboard).toHaveLength(1)
    expect(keyboard.inline_keyboard[0][0].callback_data).toBe('paw:approve:sentinel-patrol')
    expect(keyboard.inline_keyboard[0][1].callback_data).toBe('paw:skip:sentinel-patrol')
  })

  it('gives a pawdev approval card only approve and skip, never a card-specific ask button', async () => {
    createPaw(db, {
      id: 'paw-dev-cycle', project_id: 'pawdev', name: 'Paw Dev Cycle', agent_id: 'pawdev--triage',
      cron: '30 8 * * 1-5', config: testConfig,
    })
    __setProjectLookupForTests(() => ({ id: 'pawdev', name: 'Paw Dev' }))
    mockRunAgent
      .mockResolvedValueOnce({ text: 'observe' })
      .mockResolvedValueOnce({ text: JSON.stringify({ findings: [{ id: 'f1', severity: 5, title: 'CI red', detail: 'main is red', is_new: true }] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ decisions: [{ finding_id: 'f1', action: 'escalate', reason: 'a merge' }] }) })

    const pawSend = vi.fn().mockResolvedValue(undefined)
    await runPawCycle(db, 'paw-dev-cycle', mockRunAgent, mockSend, undefined, pawSend)

    __setProjectLookupForTests(undefined)
    const keyboard = pawSend.mock.calls[0][2]
    expect(keyboard.inline_keyboard).toHaveLength(1)
    expect(keyboard.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data))
      .toEqual(['paw:approve:paw-dev-cycle', 'paw:skip:paw-dev-cycle'])
  })

  it('raises a finding the DECIDE phase escalates to severity 4, so the cycle parks', async () => {
    createPaw(db, {
      id: 'esc-paw', project_id: 'default', name: 'Esc', agent_id: 'auditor', cron: '0 9 * * *',
      config: { ...testConfig, approval_threshold: 4 },
    })
    mockRunAgent
      .mockResolvedValueOnce({ text: 'observe' })
      .mockResolvedValueOnce({ text: JSON.stringify({ findings: [{ id: 'f1', severity: 3, title: 'External question', detail: 'needs a public reply', is_new: true }] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ decisions: [{ finding_id: 'f1', action: 'escalate', reason: 'a public reply' }] }) })

    const cycleId = await runPawCycle(db, 'esc-paw', mockRunAgent, mockSend)

    const cycle = getCycle(db, cycleId)
    expect(cycle!.phase).toBe('decide')
    expect(cycle!.state.approval_requested).toBe(true)
    expect(cycle!.findings[0].severity).toBe(4)
  })

  it('always_run_act runs ACT and the post-ACT handler on a quiet cycle', async () => {
    const seen: string[] = []
    registerHandler('test-quiet-act', async () => { seen.push('ran'); return 'queue drained' })
    createPaw(db, {
      id: 'quiet-paw', project_id: 'default', name: 'Quiet', agent_id: 'auditor', cron: '0 9 * * *',
      config: { ...testConfig, post_act_handler: 'test-quiet-act', always_run_act: true },
    })
    mockRunAgent
      .mockResolvedValueOnce({ text: 'observe' })
      .mockResolvedValueOnce({ text: JSON.stringify({ findings: [] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ decisions: [] }) })
      .mockResolvedValueOnce({ text: 'act text' })

    const cycleId = await runPawCycle(db, 'quiet-paw', mockRunAgent, mockSend)

    expect(seen).toEqual(['ran'])
    expect(getCycle(db, cycleId)!.report).toBe('queue drained')
  })

  it('runs post_analyze_handler with the raw ANALYZE text before DECIDE', async () => {
    const seen: string[] = []
    registerHandler('test-analyze', async (_c, _p, _proj, text) => { seen.push(text); return })
    createPaw(db, {
      id: 'hook-paw', project_id: 'default', name: 'Hook', agent_id: 'auditor', cron: '0 9 * * *',
      config: { ...testConfig, post_analyze_handler: 'test-analyze' },
    })
    mockRunAgent
      .mockResolvedValueOnce({ text: 'observe' })
      .mockResolvedValueOnce({ text: JSON.stringify({ findings: [] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ decisions: [], max_severity: 0 }) })

    await runPawCycle(db, 'hook-paw', mockRunAgent, mockSend)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('findings')
  })
})
