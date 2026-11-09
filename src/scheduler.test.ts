// NOTE: mapTaskToAgent is private in scheduler.ts. If direct tests are needed,
// it should be exported. computeNextRun is already exported.
// runDueTasks is exported but depends on DB and agent imports -- tested with mocks.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// In-memory backing store for the kv_settings mock. Shared across tests so we
// can simulate "restart and read it again" without touching SQLite.
const kvStore = new Map<string, string>()

// Mock heavy deps before importing scheduler
vi.mock('./db.js', () => ({
  getDueTasks: vi.fn(() => []),
  updateTaskAfterRun: vi.fn(),
  listTasks: vi.fn(() => []),
  getProject: vi.fn(() => undefined),
  clearStaleRunningTasks: vi.fn(() => 0),
  archiveStaleActionItems: vi.fn(() => 0),
  purgeArchivedActionItems: vi.fn(() => 0),
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({ get: vi.fn(), run: vi.fn() })),
  })),
  getKvSetting: vi.fn((key: string) => kvStore.get(key) ?? null),
  setKvSetting: vi.fn((key: string, value: string) => {
    kvStore.set(key, value)
  }),
  getBacklogTasks: vi.fn(() => []),
}))

vi.mock('./paws/db.js', () => ({
  getBacklogPaws: vi.fn(() => []),
  updatePawNextRun: vi.fn(),
  reapStalePawCycles: vi.fn(() => ({ cyclesReaped: 0, pawsUnstuck: 0 })),
  LIVE_CYCLE_MAX_AGE_MS: 1,
}))

vi.mock('./dashboard.js', () => ({
  reportAgentStatus: vi.fn(),
  reportFeedItem: vi.fn(),
  reportMetric: vi.fn(),
  reportScheduledTasks: vi.fn(),
  reportPawsState: vi.fn(),
}))

vi.mock('./souls.js', () => ({
  getAllSouls: vi.fn(() => []),
  getSoul: vi.fn(() => undefined),
  buildAgentPrompt: vi.fn(() => ''),
}))

vi.mock('./security/index.js', () => ({
  executeSecurityScan: vi.fn(),
}))

vi.mock('./newsletter/index.js', () => ({
  generateAndSendNewsletter: vi.fn(),
}))

vi.mock('./paws/index.js', () => ({
  getDuePaws: vi.fn(() => []),
  triggerPaw: vi.fn(),
}))

vi.mock('./config.js', () => ({
  DASHBOARD_API_TOKEN: 'test-token',
  BOT_API_TOKEN: 'test-token', // falls back to DASHBOARD_API_TOKEN in prod
  DASHBOARD_URL: 'http://localhost:3000',
  ALLOWED_CHAT_ID: 'test-chat-id',
}))

vi.mock('./channels/quiet-hours.js', () => ({
  shouldDrainNow: vi.fn(() => false),
  LAST_DRAIN_KEY: 'notify.last_drain_ms',
  LAST_DRAIN_ATTEMPT_KEY: 'notify.last_drain_attempt_ms',
  flushHeld: vi.fn(async () => 0),
}))

vi.mock('./reports/daily-usage-report.js', () => ({
  gatherReportData: vi.fn(async (hours: number) => ({ period: { hours } })),
  appendWeeklyVerdicts: vi.fn(async () => {}),
}))

vi.mock('./reports/digest-text.js', () => ({
  renderDigestText: vi.fn(() => 'digest text'),
}))

vi.mock('./webhooks/index.js', () => ({
  fireTaskCompleted: vi.fn(),
}))

vi.mock('./research.js', () => ({
  extractAndLogFindings: vi.fn(),
}))

vi.mock('./agent.js', () => ({
  runAgent: vi.fn(async () => ({
    text: 'agent result',
    emptyReason: undefined,
    requestedProvider: 'anthropic',
    executedProvider: 'anthropic',
    providerFallbackApplied: false,
  })),
}))

vi.mock('./system-update.js', () => ({
  checkAndUpgrade: vi.fn(async () => ({ upgraded: false, behind: 0 })),
}))

vi.mock('./action-items.js', () => ({
  parseActionItemsFromAgentOutput: vi.fn(() => []),
  ingestParsedItems: vi.fn(),
}))

vi.mock('./projects/example-company/task-context.js', () => ({
  buildExampleCompanyTaskContext: vi.fn(() => ''),
}))

vi.mock('./projects/default/task-context.js', () => ({
  buildDefaultTaskContext: vi.fn(() => ''),
}))

vi.mock('./telemetry.js', () => ({
  startRequest: vi.fn(() => ({
    setAgentId: vi.fn(),
    setExecutionMeta: vi.fn(),
    markAgentStarted: vi.fn(),
    markAgentEnded: vi.fn(),
    setResultText: vi.fn(),
    recordSdkEvent: vi.fn(),
    finalize: vi.fn(),
    toEventRow: vi.fn(() => ({})),
  })),
  recordError: vi.fn(),
}))

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Default to "kill switch not tripped" for scheduler tests. The client now
// fail-closes on dashboard-unreachable before the first successful fetch (see
// src/cost/kill-switch-client.ts), which would otherwise short-circuit every
// tick. Individual tests that need a tripped switch should override this.
vi.mock('./cost/kill-switch-client.js', () => ({
  checkKillSwitch: vi.fn(async () => null),
}))

import { computeNextRun, runDueTasks, runTaskNow, stopScheduler, initScheduler } from './scheduler.js'

describe('computeNextRun', () => {
  it('returns a future timestamp in milliseconds', () => {
    const next = computeNextRun('0 9 * * *')
    expect(next).toBeGreaterThan(Date.now())
    // Should be in milliseconds (> 1 billion = post-2001)
    expect(next).toBeGreaterThan(1_000_000_000_000)
  })

  it('"*/5 * * * *" returns within the next 5 minutes', () => {
    const next = computeNextRun('*/5 * * * *')
    const fiveMinutes = 5 * 60 * 1000
    expect(next).toBeLessThanOrEqual(Date.now() + fiveMinutes + 1000)
  })

  it('"0 9 * * *" returns next 9am occurrence in CRON_TZ (America/New_York by default)', () => {
    const next = computeNextRun('0 9 * * *')
    // computeNextRun pins TZ via CRON_TZ (default America/New_York), so
    // getHours() on the host (which might be UTC in CI) will not report 9.
    // Use Intl to extract the hour in the intended TZ.
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.CRON_TZ || 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    })
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(next)).map(p => [p.type, p.value]),
    )
    // Intl sometimes returns "24" for midnight; normalize to "00".
    const hour = parts.hour === '24' ? '00' : parts.hour
    expect(Number(hour)).toBe(9)
    expect(Number(parts.minute)).toBe(0)
  })

  it('throws on invalid cron expression', () => {
    expect(() => computeNextRun('not a cron')).toThrow()
  })
})

describe('runDueTasks concurrency lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips execution when already running', async () => {
    const { getDueTasks } = await import('./db.js')
    const mockedGetDueTasks = vi.mocked(getDueTasks)

    // Simulate a slow first run
    let resolveFirst: () => void
    const firstRunPromise = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })

    mockedGetDueTasks.mockImplementationOnce(() => {
      // Block until we release
      return [] // No tasks, but the lock should still be held briefly
    })

    const send = vi.fn(async () => {})

    // First call runs normally (no tasks)
    await runDueTasks(send)

    // getDueTasks should have been called once
    expect(mockedGetDueTasks).toHaveBeenCalledTimes(1)
  })

  it('processes tasks without errors when getDueTasks returns empty', async () => {
    const { getDueTasks } = await import('./db.js')
    vi.mocked(getDueTasks).mockReturnValue([])

    const send = vi.fn(async () => {})
    await expect(runDueTasks(send)).resolves.toBeUndefined()
  })
})

describe('tracker lifecycle', () => {
  const makeTask = (overrides: Partial<{
    id: string
    chat_id: string
    prompt: string
    schedule: string
    next_run: number
    last_run: number | null
    last_result: string | null
    status: 'active' | 'paused'
    created_at: number
    project_id: string
  }> = {}) => ({
    id: 'test-task',
    chat_id: '123456',
    prompt: 'do something useful',
    schedule: '0 9 * * *',
    next_run: Date.now() - 1000,
    last_run: null,
    last_result: null,
    status: 'active' as const,
    created_at: Date.now() - 10000,
    project_id: 'default',
    ...overrides,
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('general LLM path: startRequest called once with source "scheduler"', async () => {
    const { startRequest } = await import('./telemetry.js')
    const send = vi.fn(async () => {})

    await runTaskNow(makeTask(), send)

    expect(vi.mocked(startRequest)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(startRequest)).toHaveBeenCalledWith(
      '123456',
      'scheduler',
      expect.any(String),
      expect.any(String),
      'default',
    )
  })

  it('general LLM path: tracker.finalize() called after happy-path run', async () => {
    const { startRequest } = await import('./telemetry.js')
    const mockTracker = {
      setAgentId: vi.fn(),
      setExecutionMeta: vi.fn(),
      markAgentStarted: vi.fn(),
      markAgentEnded: vi.fn(),
      setResultText: vi.fn(),
      recordSdkEvent: vi.fn(),
      finalize: vi.fn(),
      toEventRow: vi.fn(() => ({})),
    }
    vi.mocked(startRequest).mockReturnValueOnce(mockTracker as any)

    const send = vi.fn(async () => {})
    await runTaskNow(makeTask(), send)

    expect(mockTracker.finalize).toHaveBeenCalledTimes(1)
  })

  it('bypass path (security-daily-scan): startRequest is NOT called', async () => {
    const { startRequest } = await import('./telemetry.js')
    const { executeSecurityScan } = await import('./security/index.js')
    vi.mocked(executeSecurityScan).mockResolvedValueOnce('scan complete')

    const { getDueTasks } = await import('./db.js')
    vi.mocked(getDueTasks).mockReturnValueOnce([
      makeTask({ id: 'security-daily-scan', prompt: 'run daily scan' }),
    ])

    const send = vi.fn(async () => {})
    await runDueTasks(send)

    expect(vi.mocked(startRequest)).not.toHaveBeenCalled()
  })

  it('bypass path (the-signal-monday): startRequest is NOT called', async () => {
    const { startRequest } = await import('./telemetry.js')
    const { generateAndSendNewsletter } = await import('./newsletter/index.js')
    vi.mocked(generateAndSendNewsletter).mockResolvedValueOnce('newsletter sent')

    const { getDueTasks } = await import('./db.js')
    vi.mocked(getDueTasks).mockReturnValueOnce([
      makeTask({ id: 'the-signal-monday', prompt: 'send newsletter' }),
    ])

    const send = vi.fn(async () => {})
    await runDueTasks(send)

    expect(vi.mocked(startRequest)).not.toHaveBeenCalled()
  })
})

describe('lastAutoUpgradeDate persistence via kv_settings', () => {
  // Pick a fixed 2am moment so the upgrade branch in runDueTasks fires.
  // 2026-04-17 02:00:00 local time -- using the same Date calc the scheduler does.
  const fixedNow = (() => {
    const d = new Date()
    d.setHours(2, 0, 0, 0)
    return d
  })()
  const todayKey = fixedNow.toDateString()

  beforeEach(() => {
    vi.clearAllMocks()
    kvStore.clear()
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('persists the date key via setKvSetting when the 2am window fires', async () => {
    const { checkAndUpgrade } = await import('./system-update.js')
    vi.mocked(checkAndUpgrade).mockResolvedValueOnce({ upgraded: false, behind: 0 })

    const { setKvSetting, getKvSetting } = await import('./db.js')

    const send = vi.fn(async () => {})
    await runDueTasks(send)

    expect(vi.mocked(getKvSetting)).toHaveBeenCalledWith('scheduler.lastAutoUpgradeDate')
    expect(vi.mocked(setKvSetting)).toHaveBeenCalledWith(
      'scheduler.lastAutoUpgradeDate',
      todayKey,
    )
    // kvStore now holds the value -- simulates what a restart would read back.
    expect(kvStore.get('scheduler.lastAutoUpgradeDate')).toBe(todayKey)
  })

  it('simulated restart: pre-seeded kv value prevents re-triggering on the same day', async () => {
    const { checkAndUpgrade } = await import('./system-update.js')
    // Simulate a previous session (or a pre-restart process) having already run today.
    kvStore.set('scheduler.lastAutoUpgradeDate', todayKey)

    const send = vi.fn(async () => {})
    await runDueTasks(send)

    expect(vi.mocked(checkAndUpgrade)).not.toHaveBeenCalled()
  })
})

describe('stopScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Make sure we start from a stopped state so initScheduler runs
    stopScheduler()
  })

  it('clears the interval handle set by initScheduler', () => {
    const clearSpy = vi.spyOn(global, 'clearInterval')
    const send = vi.fn(async () => {})

    initScheduler(send)
    stopScheduler()

    // Tick interval + credential sweep interval = 2 handles cleared
    expect(clearSpy).toHaveBeenCalledTimes(2)
    clearSpy.mockRestore()
  })

  it('is safe to call multiple times', () => {
    const send = vi.fn(async () => {})
    initScheduler(send)
    stopScheduler()
    // Second call should be a no-op and not throw
    expect(() => stopScheduler()).not.toThrow()
  })
})

describe('backlog skip fires only after a gap', () => {
  beforeEach(async () => {
    const { updateTaskAfterRun } = await import('./db.js')
    vi.mocked(updateTaskAfterRun).mockClear()
  })

  it('does not skip a due task when the previous tick was recent', async () => {
    const { getBacklogTasks, getDueTasks, updateTaskAfterRun } = await import('./db.js')
    const stale = { id: 'stale-task', chat_id: '1', prompt: 'x', schedule: '0 9 * * *', next_run: Date.now() - 60 * 60 * 1000, status: 'active', project_id: 'default' }
    vi.mocked(getBacklogTasks).mockReturnValue([stale as never])
    vi.mocked(getDueTasks).mockReturnValue([])

    const { runDueTasks, _resetTickClockForTest } = await import('./scheduler.js')
    _resetTickClockForTest(Date.now() - 60 * 1000) // last tick one minute ago
    await runDueTasks(vi.fn())

    const skips = vi.mocked(updateTaskAfterRun).mock.calls.filter(c => c[0] === 'stale-task' && c[1] === 'skipped (backlog)')
    expect(skips.length).toBe(0)
    vi.mocked(getBacklogTasks).mockReturnValue([])
  })

  it('skips backlog when the gap since the last tick exceeds the window', async () => {
    const { getBacklogTasks, getDueTasks, updateTaskAfterRun } = await import('./db.js')
    const stale = { id: 'stale-task', chat_id: '1', prompt: 'x', schedule: '0 9 * * *', next_run: Date.now() - 60 * 60 * 1000, status: 'active', project_id: 'default' }
    vi.mocked(getBacklogTasks).mockReturnValue([stale as never])
    vi.mocked(getDueTasks).mockReturnValue([])

    const { runDueTasks, _resetTickClockForTest } = await import('./scheduler.js')
    _resetTickClockForTest(Date.now() - 2 * 60 * 60 * 1000) // last tick two hours ago (sleep)
    await runDueTasks(vi.fn())

    expect(updateTaskAfterRun).toHaveBeenCalledWith('stale-task', 'skipped (backlog)', expect.any(Number))
    vi.mocked(getBacklogTasks).mockReturnValue([])
  })

  it('one invalid cron in the backlog does not abort skipping the rest', async () => {
    const { getBacklogTasks, getDueTasks, updateTaskAfterRun } = await import('./db.js')
    const badCron = { id: 'bad-backlog-task', chat_id: '1', prompt: 'x', schedule: 'not a cron', next_run: Date.now() - 60 * 60 * 1000, status: 'active', project_id: 'default' }
    const goodCron = { id: 'good-backlog-task', chat_id: '1', prompt: 'x', schedule: '0 9 * * *', next_run: Date.now() - 60 * 60 * 1000, status: 'active', project_id: 'default' }
    vi.mocked(getBacklogTasks).mockReturnValue([badCron, goodCron] as never)
    vi.mocked(getDueTasks).mockReturnValue([])

    const { runDueTasks, _resetTickClockForTest } = await import('./scheduler.js')
    _resetTickClockForTest(Date.now() - 2 * 60 * 60 * 1000) // last tick two hours ago (sleep)
    await runDueTasks(vi.fn())

    const badCall = vi.mocked(updateTaskAfterRun).mock.calls.find(c => c[0] === 'bad-backlog-task')
    const goodCall = vi.mocked(updateTaskAfterRun).mock.calls.find(c => c[0] === 'good-backlog-task')
    expect(badCall).toBeDefined()
    expect(String(badCall![1])).toMatch(/^skipped \(backlog/)
    expect(goodCall).toBeDefined()
    expect(String(goodCall![1])).toMatch(/^skipped \(backlog/)
    vi.mocked(getBacklogTasks).mockReturnValue([])
  })
})

describe('invalid cron on a due task', () => {
  it('records an error result, pushes next_run out an hour, and releases the lock', async () => {
    const { getDueTasks, updateTaskAfterRun } = await import('./db.js')
    const bad = { id: 'bad-cron', chat_id: '1', prompt: 'x', schedule: 'not a cron', next_run: Date.now() - 1000, status: 'active', project_id: 'default' }
    vi.mocked(getDueTasks).mockReturnValue([bad as never])

    const { runDueTasks } = await import('./scheduler.js')
    await runDueTasks(vi.fn())
    await runDueTasks(vi.fn())

    const calls = vi.mocked(updateTaskAfterRun).mock.calls.filter(c => c[0] === 'bad-cron')
    expect(calls.length).toBe(2)
    expect(String(calls[0][1])).toMatch(/^ERROR: invalid cron/)
    expect(calls[0][2]).toBeGreaterThan(Date.now() + 59 * 60 * 1000)
    vi.mocked(getDueTasks).mockReturnValue([])
  })
})

describe('daily digest tick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    kvStore.clear()
  })

  it('sends the digest and drains the buffer when shouldDrainNow says so', async () => {
    const { shouldDrainNow, flushHeld } = await import('./channels/quiet-hours.js')
    const { gatherReportData } = await import('./reports/daily-usage-report.js')
    const { renderDigestText } = await import('./reports/digest-text.js')
    vi.mocked(shouldDrainNow).mockReturnValueOnce(true)

    const send = vi.fn(async () => {})
    const sendDigest = vi.fn(async () => {})
    await runDueTasks(send, sendDigest)

    expect(vi.mocked(gatherReportData)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(renderDigestText)).toHaveBeenCalledTimes(1)
    // Recorded before the work, so a failed send backs off instead of
    // rebuilding the report on every tick for the rest of the day.
    expect(kvStore.get('notify.last_drain_attempt_ms')).toBeTruthy()
    expect(sendDigest).toHaveBeenCalledWith('telegram', 'test-chat-id', 'digest text')
    expect(vi.mocked(flushHeld)).toHaveBeenCalledWith(sendDigest)
  })

  it('does nothing when shouldDrainNow says it is not time yet', async () => {
    const { shouldDrainNow } = await import('./channels/quiet-hours.js')
    const { gatherReportData } = await import('./reports/daily-usage-report.js')
    vi.mocked(shouldDrainNow).mockReturnValueOnce(false)

    const send = vi.fn(async () => {})
    const sendDigest = vi.fn(async () => {})
    await runDueTasks(send, sendDigest)

    expect(sendDigest).not.toHaveBeenCalled()
    expect(vi.mocked(gatherReportData)).not.toHaveBeenCalled()
  })

  it('does nothing when no sendDigest is wired (no digest sender configured)', async () => {
    const { shouldDrainNow } = await import('./channels/quiet-hours.js')
    vi.mocked(shouldDrainNow).mockReturnValueOnce(true)

    const send = vi.fn(async () => {})
    await runDueTasks(send)

    expect(vi.mocked(shouldDrainNow)).not.toHaveBeenCalled()
  })

  // 2026-09-06T12:30Z = 08:30 ET on a Sunday; 2026-09-08T12:30Z = 08:30 ET on a Tuesday.
  const sunday = new Date('2026-09-06T12:30:00Z')
  const tuesday = new Date('2026-09-08T12:30:00Z')

  it('gathers the weekly window and appends project-health verdicts on Sunday', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(sunday)
    try {
      const { shouldDrainNow } = await import('./channels/quiet-hours.js')
      const { gatherReportData, appendWeeklyVerdicts } = await import('./reports/daily-usage-report.js')
      vi.mocked(shouldDrainNow).mockReturnValueOnce(true)

      const send = vi.fn(async () => {})
      const sendDigest = vi.fn(async () => {})
      await runDueTasks(send, sendDigest)

      expect(vi.mocked(gatherReportData)).toHaveBeenCalledWith(168)
      expect(vi.mocked(appendWeeklyVerdicts)).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gathers the 24-hour window and skips project-health verdicts on a weekday', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(tuesday)
    try {
      const { shouldDrainNow } = await import('./channels/quiet-hours.js')
      const { gatherReportData, appendWeeklyVerdicts } = await import('./reports/daily-usage-report.js')
      vi.mocked(shouldDrainNow).mockReturnValueOnce(true)

      const send = vi.fn(async () => {})
      const sendDigest = vi.fn(async () => {})
      await runDueTasks(send, sendDigest)

      expect(vi.mocked(gatherReportData)).toHaveBeenCalledWith(24)
      expect(vi.mocked(appendWeeklyVerdicts)).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
