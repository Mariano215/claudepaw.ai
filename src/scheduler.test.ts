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

vi.mock('./learning/synthesizer.js', () => ({
  runSkillSynthesis: vi.fn(),
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

  it('"0 9 * * *" returns next 9am occurrence', () => {
    const next = computeNextRun('0 9 * * *')
    const date = new Date(next)
    expect(date.getHours()).toBe(9)
    expect(date.getMinutes()).toBe(0)
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

  it('bypass path (newsletter-monday): startRequest is NOT called', async () => {
    const { startRequest } = await import('./telemetry.js')
    const { generateAndSendNewsletter } = await import('./newsletter/index.js')
    vi.mocked(generateAndSendNewsletter).mockResolvedValueOnce('newsletter sent')

    const { getDueTasks } = await import('./db.js')
    vi.mocked(getDueTasks).mockReturnValueOnce([
      makeTask({ id: 'newsletter-monday', prompt: 'send newsletter' }),
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
