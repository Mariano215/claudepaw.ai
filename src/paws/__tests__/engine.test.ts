// src/paws/__tests__/engine.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initPawsTables, createPaw, getCycle, getLatestCycle } from '../db.js'
import { runPawCycle } from '../engine.js'
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
    expect(mockSend).toHaveBeenCalledWith('12345', expect.stringContaining('need your call'))
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
    expect(keyboard.inline_keyboard.at(-1)[0].callback_data).toMatch(/^pf:dismiss-all:sentinel-patrol:\d+$/)
  })
})
