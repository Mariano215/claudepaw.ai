import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock db module
vi.mock('./db.js', () => ({
  getSession: vi.fn(() => null),
  setSession: vi.fn(),
  clearSession: vi.fn(),
  listTasks: vi.fn(() => []),
  getChatProject: vi.fn(() => 'default'),
  setChatProject: vi.fn(),
  listProjects: vi.fn(() => [
    { id: 'default', name: 'default', slug: 'default', display_name: 'ClaudePaw', icon: null, created_at: 0 },
  ]),
  getProjectByName: vi.fn(() => null),
  getProjectBySlug: vi.fn(() => null),
  getProject: vi.fn((id: string) => {
    if (id === 'default') return { id: 'default', name: 'default', slug: 'default', display_name: 'ClaudePaw', icon: null, created_at: 0 }
    return undefined
  }),
  logChannelMessage: vi.fn(),
}))

// Mock souls module
vi.mock('./souls.js', () => ({
  getSoul: vi.fn((id: string) => {
    if (id === 'scout') {
      return { id: 'scout', name: 'Scout', emoji: '🔭', role: 'Researcher', mode: 'active', keywords: [], capabilities: [], systemPrompt: '' }
    }
    return undefined
  }),
  getAllSouls: vi.fn(() => [
    { id: 'scout', name: 'Scout', emoji: '🔭', role: 'Researcher', mode: 'active', keywords: [], capabilities: [], systemPrompt: '' },
    { id: 'auditor', name: 'Auditor', emoji: '🛡️', role: 'Security', mode: 'active', keywords: [], capabilities: [], systemPrompt: '' },
  ]),
  buildAgentPrompt: vi.fn(() => ''),
}))

// Mock voice module
vi.mock('./voice.js', () => ({
  voiceCapabilities: vi.fn(() => ({ stt: false, tts: false })),
  transcribeAudio: vi.fn(),
  synthesizeSpeech: vi.fn(),
}))

// Mock other deps that pipeline imports
vi.mock('./agent.js', () => ({ runAgent: vi.fn() }))
vi.mock('./memory.js', () => ({ buildMemoryContext: vi.fn(), saveConversationTurn: vi.fn() }))
vi.mock('./dashboard.js', () => ({ reportFeedItem: vi.fn(), reportAgentStatus: vi.fn(), reportMetric: vi.fn(), reportChannelLog: vi.fn() }))
vi.mock('./agent-router.js', () => ({ routeMessage: vi.fn() }))
vi.mock('./channels/formatters.js', () => ({ getFormatter: vi.fn(() => (t: string) => t), splitMessage: vi.fn((t: string) => [t]) }))
vi.mock('./config.js', () => ({ TYPING_REFRESH_MS: 5000, PROJECT_ROOT: '/mock/project/root' }))
vi.mock('./telemetry.js', () => ({
  startRequest: vi.fn(() => ({
    setAgentId: vi.fn(),
    setExecutionMeta: vi.fn(),
    markMemoryInjected: vi.fn(),
    markAgentStarted: vi.fn(),
    markAgentEnded: vi.fn(),
    setResultText: vi.fn(),
    markResponseSent: vi.fn(),
    recordSdkEvent: vi.fn(),
    finalize: vi.fn(),
  })),
}))
vi.mock('./guard/index.js', () => ({
  guardChain: {
    preProcess: vi.fn(async (text: string) => ({
      allowed: true,
      flagged: false,
      sanitizedText: text,
      triggeredLayers: [],
      requestId: 'guard-test',
    })),
    postProcess: vi.fn(async () => ({
      blocked: false,
      triggeredLayers: [],
      blockReason: null,
    })),
    hardenPrompt: vi.fn(() => ({
      systemPrompt: '',
      canary: 'test-canary',
      delimiterID: 'test-delimiter',
    })),
  },
}))
vi.mock('./guard/config.js', () => ({ GUARD_CONFIG: { fallbackResponse: 'I cannot comply.' } }))
vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { handleCommand, toggleVoiceMode, isVoiceMode, processMessage } from './pipeline.js'
import { clearSession, logChannelMessage } from './db.js'
import { runAgent } from './agent.js'
import { reportChannelLog, reportFeedItem } from './dashboard.js'

describe('handleCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('/newchat clears session and returns handled', async () => {
    const result = await handleCommand('tg:123', 'telegram', '123', 'newchat', '')
    expect(result.handled).toBe(true)
    expect(result.response).toContain('Session cleared')
    expect(clearSession).toHaveBeenCalledWith('tg:123')
  })

  it('/forget also clears session', async () => {
    const result = await handleCommand('tg:123', 'telegram', '123', 'forget', '')
    expect(result.handled).toBe(true)
    expect(result.response).toContain('Session cleared')
  })

  it('/agents lists available agents', async () => {
    const result = await handleCommand('tg:123', 'telegram', '123', 'agents', '')
    expect(result.handled).toBe(true)
    expect(result.response).toContain('Scout')
    expect(result.response).toContain('Auditor')
  })

  it('/voice returns not available when TTS is off', async () => {
    const result = await handleCommand('tg:123', 'telegram', '123', 'voice', '')
    expect(result.handled).toBe(true)
    expect(result.response).toContain('not available')
  })

  it('/schedule with no tasks returns empty message', async () => {
    const result = await handleCommand('tg:123', 'telegram', '123', 'schedule', '')
    expect(result.handled).toBe(true)
    expect(result.response).toContain('No scheduled tasks')
  })

  it('/status returns status info', async () => {
    const result = await handleCommand('tg:123', 'telegram', '123', 'status', '')
    expect(result.handled).toBe(true)
    expect(result.response).toContain('ClaudePaw Status')
    expect(result.response).toContain('Channel: telegram')
  })

  it('/reset with agent name clears agent session', async () => {
    const result = await handleCommand('tg:123', 'telegram', '123', 'reset', 'scout')
    expect(result.handled).toBe(true)
    expect(result.response).toContain('Scout session cleared')
    expect(clearSession).toHaveBeenCalledWith('tg:123', 'scout')
  })

  it('/reset with unknown agent returns error', async () => {
    const result = await handleCommand('tg:123', 'telegram', '123', 'reset', 'nonexistent')
    expect(result.handled).toBe(true)
    expect(result.response).toContain('Unknown agent')
  })

  it('unknown command returns not handled', async () => {
    const result = await handleCommand('tg:123', 'telegram', '123', 'foobar', '')
    expect(result.handled).toBe(false)
    expect(result.response).toBeUndefined()
  })

  it('/switch with no args shows current project and list', async () => {
    const result = await handleCommand('tg:123', 'telegram', '123', 'switch', '')
    expect(result.handled).toBe(true)
    expect(result.response).toContain('ClaudePaw')
    expect(result.response).toContain('active')
  })

  it('/switch with unknown project returns error', async () => {
    const result = await handleCommand('tg:123', 'telegram', '123', 'switch', 'nonexistent')
    expect(result.handled).toBe(true)
    expect(result.response).toContain('No project found')
  })

  it('/switch with valid project sets chat project', async () => {
    const { getProjectByName, setChatProject } = await import('./db.js')
    const mockProject = { id: 'test-proj', name: 'test', slug: 'test', display_name: 'Test Project', icon: '🧪', created_at: 0 }
    vi.mocked(getProjectByName).mockReturnValueOnce(mockProject as any)

    const result = await handleCommand('tg:123', 'telegram', '123', 'switch', 'test')
    expect(result.handled).toBe(true)
    expect(result.response).toContain('Test Project')
    expect(setChatProject).toHaveBeenCalledWith('tg:123', 'test-proj')
  })
})

describe('voice mode toggle', () => {
  it('toggles voice mode on and off', () => {
    const id = 'test:voice'
    expect(isVoiceMode(id)).toBe(false)

    const on = toggleVoiceMode(id)
    expect(on).toBe(true)
    expect(isVoiceMode(id)).toBe(true)

    const off = toggleVoiceMode(id)
    expect(off).toBe(false)
    expect(isVoiceMode(id)).toBe(false)
  })
})

describe('processMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs outbound failures so dashboard errors are visible', async () => {
    const send = vi.fn(async () => {})
    vi.mocked(runAgent).mockRejectedValueOnce(Object.assign(new Error('Claude Code process exited with code 1'), {
      executionMeta: {
        requestedProvider: 'claude_desktop',
        attemptedProvider: 'codex_local',
        nextProvider: null,
        providerFallbackApplied: true,
      },
    }))

    await processMessage(
      {
        channelId: 'dashboard',
        chatId: 'dashboard:default',
        text: 'builder fallback test',
        isVoice: false,
        source: 'dashboard',
        projectId: 'default',
        agentId: 'scout',
      },
      {
        id: 'dashboard',
        name: 'Dashboard',
        start: async () => {},
        stop: async () => {},
        isRunning: () => true,
        send,
        sendVoice: async () => {},
        sendTyping: async () => {},
        capabilities: () => ({ voice: false, media: false, formatting: 'plain', maxMessageLength: 4000, typing: false }),
      },
    )

    expect(logChannelMessage).toHaveBeenCalledTimes(2)
    expect(logChannelMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      direction: 'out',
      channel: 'dashboard',
      chatId: 'dashboard:default',
      agentId: 'scout',
      error: 'Claude Code process exited with code 1',
      content: expect.stringContaining('requested=claude_desktop'),
    }))
    expect(reportChannelLog).toHaveBeenLastCalledWith(expect.objectContaining({
      channel: 'dashboard',
      error: 'Claude Code process exited with code 1',
    }))
    expect(reportFeedItem).toHaveBeenCalledWith('scout', 'Error', expect.stringContaining('attempted=codex_local'))
    expect(send).toHaveBeenCalledWith('dashboard:default', 'Something went wrong running that command. Check the logs.')
  })
})
