import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'

const TEST_DIR = join(tmpdir(), `claudepaw-agent-runtime-${process.pid}`)

let mockProjectById: Record<string, { id: string; slug: string }> = {}
let mockProjectSettingsById: Record<string, any> = {}
let mockCredentials: Record<string, string> = {}
const mockQuery = vi.fn()
const mockExecFile = vi.fn()
const mockSpawn = vi.fn()

vi.mock('./config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const dir = path.join(os.tmpdir(), `claudepaw-agent-runtime-${process.pid}`)
  return {
    PROJECT_ROOT: dir,
    CLAUDE_CWD: dir,
  }
})

vi.mock('./env.js', () => ({
  readEnvFile: () => ({}),
}))

vi.mock('./db.js', () => ({
  getProject: (id: string) => mockProjectById[id],
  getProjectSettings: (projectId: string) => mockProjectSettingsById[projectId],
}))

vi.mock('./credentials.js', () => ({
  getCredential: (projectId: string, service: string, key: string) =>
    mockCredentials[`${projectId}:${service}:${key}`] ?? null,
}))

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: any[]) => mockQuery(...args),
}))

vi.mock('node:child_process', () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
  spawn: (...args: any[]) => mockSpawn(...args),
}))

import { resolveExecutionSettings, runAgentWithResolvedExecution } from './agent-runtime.js'

describe('agent runtime', () => {
  beforeAll(() => {
    mkdirSync(join(TEST_DIR, 'agents'), { recursive: true })
    mkdirSync(join(TEST_DIR, 'projects', 'test-project', 'agents'), { recursive: true })
  })

  beforeEach(() => {
    mockProjectById = {
      'test-project': { id: 'test-project', slug: 'test-project' },
    }
    mockProjectSettingsById = {}
    mockCredentials = {}
    mockQuery.mockReset()
    mockExecFile.mockReset()
    mockSpawn.mockReset()
    vi.restoreAllMocks()
  })

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('resolves project defaults and agent overrides', () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'anthropic_api',
      execution_provider_secondary: 'claude_desktop',
      execution_model_primary: 'claude-sonnet-4-6',
      fallback_policy: 'enabled',
      model_tier: 'balanced',
    }

    writeFileSync(
      join(TEST_DIR, 'projects', 'test-project', 'agents', 'builder.md'),
      `---
id: builder
name: Builder
emoji: "🔨"
role: Platform Developer
mode: on-demand
provider_mode: codex_local
provider: openai_api
model: gpt-5.2-codex
model_secondary: gpt-5-mini
model_fallback: gpt-5.4
model_tier: premium
fallback_policy: enabled
keywords:
  - code
capabilities:
  - code-execution
---

You build things.
`,
      'utf-8',
    )

    const resolved = resolveExecutionSettings({
      projectId: 'test-project',
      projectSlug: 'test-project',
      agentId: 'builder',
    })

    expect(resolved.provider).toBe('codex_local')
    expect(resolved.secondaryProvider).toBe('claude_desktop')
    expect(resolved.fallbackProvider).toBe('openai_api')
    expect(resolved.model).toBe('gpt-5.2-codex')
    expect(resolved.modelPrimary).toBe('gpt-5.2-codex')
    expect(resolved.modelSecondary).toBe('gpt-5-mini')
    expect(resolved.modelFallback).toBe('gpt-5.4')
    expect(resolved.modelTier).toBe('premium')
    expect(resolved.fallbackPolicy).toBe('enabled')
  })

  it('inherits project provider when agent execution mode is inherit', () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'openai_api',
      execution_model_primary: 'gpt-5.4',
      fallback_policy: 'disabled',
      model_tier: 'premium',
    }

    writeFileSync(
      join(TEST_DIR, 'projects', 'test-project', 'agents', 'reviewer.md'),
      `---
id: reviewer
name: Reviewer
provider_mode: inherit
provider: claude_desktop
---
`,
      'utf-8',
    )

    const resolved = resolveExecutionSettings({
      projectId: 'test-project',
      projectSlug: 'test-project',
      agentId: 'reviewer',
    })

    expect(resolved.provider).toBe('openai_api')
    expect(resolved.model).toBe('gpt-5.4')
    expect(resolved.modelPrimary).toBe('gpt-5.4')
    expect(resolved.fallbackPolicy).toBe('disabled')
    expect(resolved.modelTier).toBe('premium')
    expect(resolved.fallbackProvider).toBe('claude_desktop')
  })

  it('applies explicit execution overrides after project resolution', () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'claude_desktop',
      fallback_policy: 'disabled',
      model_tier: 'balanced',
    }

    const resolved = resolveExecutionSettings({
      projectId: 'test-project',
      executionOverride: {
        provider: 'codex_local',
        secondaryProvider: 'openai_api',
        model: 'gpt-5.4',
        modelSecondary: 'gpt-5-mini',
        modelFallback: 'gpt-5.2-codex',
        fallbackPolicy: 'disabled',
        modelTier: 'premium',
        fallbackProvider: 'claude_desktop',
      },
    })

    expect(resolved.provider).toBe('codex_local')
    expect(resolved.secondaryProvider).toBe('openai_api')
    expect(resolved.model).toBe('gpt-5.4')
    expect(resolved.modelPrimary).toBe('gpt-5.4')
    expect(resolved.modelSecondary).toBe('gpt-5-mini')
    expect(resolved.modelFallback).toBe('gpt-5.2-codex')
    expect(resolved.fallbackPolicy).toBe('disabled')
    expect(resolved.modelTier).toBe('premium')
    expect(resolved.fallbackProvider).toBe('claude_desktop')
  })

  it('normalizes legacy fallback policy values in runtime overrides', () => {
    const resolved = resolveExecutionSettings({
      executionOverride: {
        provider: 'openai_api',
        fallbackPolicy: 'auto_on_error',
        fallbackProvider: 'claude_desktop',
      },
    })

    expect(resolved.provider).toBe('openai_api')
    expect(resolved.fallbackPolicy).toBe('enabled')
    expect(resolved.fallbackProvider).toBe('claude_desktop')
  })

  it('falls back from anthropic api to claude desktop when fallback is enabled', async () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'anthropic_api',
      execution_provider_fallback: 'claude_desktop',
      fallback_policy: 'enabled',
      model_tier: 'balanced',
    }
    mockCredentials['test-project:anthropic:api_key'] = 'anthropic-key'

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: 'quota exceeded' } }),
      })),
    )

    mockQuery.mockImplementation(() => (async function* () {
      yield { type: 'system', subtype: 'init', sessionId: 'claude-session', model: 'claude-desktop' }
      yield { type: 'result', result: 'fallback ok', subtype: 'success' }
    })())

    const events: any[] = []
    const { result, settings } = await runAgentWithResolvedExecution(
      { prompt: 'hello', onEvent: (event) => events.push(event) },
      { projectId: 'test-project' },
    )

    expect(settings.provider).toBe('anthropic_api')
    expect(result.requestedProvider).toBe('anthropic_api')
    expect(result.executedProvider).toBe('claude_desktop')
    expect(result.providerFallbackApplied).toBe(true)
    expect(result.text).toBe('fallback ok')
    expect(events.some((event) => event.type === 'result')).toBe(true)
  })

  it('uses openai api directly when configured', async () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'openai_api',
      model_tier: 'balanced',
    }
    mockCredentials['test-project:openai:api_key'] = 'openai-key'

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          output_text: 'openai ok',
          usage: { input_tokens: 12, output_tokens: 4 },
        }),
      })),
    )

    const events: any[] = []
    const { result } = await runAgentWithResolvedExecution(
      { prompt: 'hello', onEvent: (event) => events.push(event) },
      { projectId: 'test-project' },
    )

    expect(result.executedProvider).toBe('openai_api')
    expect(result.providerFallbackApplied).toBe(false)
    expect(result.text).toBe('openai ok')
    expect(events[0]?.type).toBe('system')
    expect(events[1]?.type).toBe('result')
  })

  it('uses provider-specific default models when none are configured', async () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'anthropic_api',
      model_tier: 'cheap',
    }
    mockCredentials['test-project:anthropic:api_key'] = 'anthropic-key'

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: 'text', text: 'anthropic ok' }],
        usage: { input_tokens: 10, output_tokens: 3 },
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const events: any[] = []
    await runAgentWithResolvedExecution(
      { prompt: 'hello', onEvent: (event) => events.push(event) },
      { projectId: 'test-project' },
    )

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}'))
    expect(body.model).toBe('claude-haiku-4-5')
    expect(events[0]?.model).toBe('claude-haiku-4-5')
  })

  it('ignores explicit models for claude desktop runs', async () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'claude_desktop',
      execution_model_primary: 'claude-sonnet-4-6',
      model_tier: 'premium',
    }

    mockQuery.mockImplementation(() => (async function* () {
      yield { type: 'system', subtype: 'init', sessionId: 'claude-session', model: 'claude-desktop' }
      yield { type: 'result', result: 'desktop ok', subtype: 'success' }
    })())

    const { result } = await runAgentWithResolvedExecution(
      { prompt: 'hello' },
      { projectId: 'test-project' },
    )

    expect(result.executedProvider).toBe('claude_desktop')
    expect(result.text).toBe('desktop ok')
  })

  it('falls back to codex-local defaults when the configured model is incompatible', async () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'codex_local',
      execution_model_primary: 'claude-sonnet-4-6',
      model_tier: 'premium',
    }

    mockSpawnSuccess(({ args }) => {
      expect(args).toContain('gpt-5.4')
    }, 'codex defaulted')

    const { result } = await runAgentWithResolvedExecution(
      { prompt: 'hello' },
      { projectId: 'test-project' },
    )

    expect(result.executedProvider).toBe('codex_local')
    expect(result.text).toBe('codex defaulted')
  })

  it('uses codex local directly when configured', async () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'codex_local',
      model_tier: 'balanced',
    }

    mockSpawnSuccess(({ args }) => {
      expect(args).toContain('--skip-git-repo-check')
    }, 'codex local ok')

    const events: any[] = []
    const { result } = await runAgentWithResolvedExecution(
      { prompt: 'hello', onEvent: (event) => events.push(event) },
      { projectId: 'test-project' },
    )

    expect(result.executedProvider).toBe('codex_local')
    expect(result.providerFallbackApplied).toBe(false)
    expect(result.text).toBe('codex local ok')
    expect(events[0]?.type).toBe('system')
    expect(events[1]?.type).toBe('result')
  })

  it('falls back from codex local to claude desktop when fallback is enabled', async () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'codex_local',
      execution_provider_fallback: 'claude_desktop',
      fallback_policy: 'enabled',
      model_tier: 'balanced',
    }

    mockSpawnFailure('network unavailable')

    mockQuery.mockImplementation(() => (async function* () {
      yield { type: 'system', subtype: 'init', sessionId: 'claude-session', model: 'claude-desktop' }
      yield { type: 'result', result: 'claude recovered', subtype: 'success' }
    })())

    const { result } = await runAgentWithResolvedExecution(
      { prompt: 'hello' },
      { projectId: 'test-project' },
    )

    expect(result.requestedProvider).toBe('codex_local')
    expect(result.executedProvider).toBe('claude_desktop')
    expect(result.providerFallbackApplied).toBe(true)
    expect(result.text).toBe('claude recovered')
  })

  it('falls back past codex local when codex reports MCP auth is required', async () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'codex_local',
      execution_provider_fallback: 'anthropic_api',
      fallback_policy: 'enabled',
      model_tier: 'balanced',
    }
    mockCredentials['test-project:anthropic:api_key'] = 'anthropic-key'

    mockSpawnFailure('worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer resource_metadata=\\"https://huggingface.co/.well-known/oauth-protected-resource/mcp?login\\"" })')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          content: [{ type: 'text', text: 'anthropic recovered' }],
          usage: { input_tokens: 10, output_tokens: 3 },
        }),
      })),
    )

    const { result } = await runAgentWithResolvedExecution(
      { prompt: 'hello' },
      { projectId: 'test-project' },
    )

    expect(result.requestedProvider).toBe('codex_local')
    expect(result.executedProvider).toBe('anthropic_api')
    expect(result.providerFallbackApplied).toBe(true)
    expect(result.text).toBe('anthropic recovered')
  })

  it('falls back from claude desktop to codex local when the desktop path returns an error result', async () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'claude_desktop',
      execution_provider_secondary: 'codex_local',
      fallback_policy: 'enabled',
      model_tier: 'balanced',
    }

    mockQuery.mockImplementation(() => (async function* () {
      yield { type: 'system', subtype: 'init', sessionId: 'claude-session', model: 'claude-desktop' }
      yield {
        type: 'result',
        result: 'usage limit reached',
        subtype: 'error_during_execution',
        is_error: true,
      }
    })())

    mockSpawnSuccess(({ args }) => {
      expect(args).toContain('gpt-5.2-codex')
    }, 'codex recovered')

    const { result } = await runAgentWithResolvedExecution(
      { prompt: 'hello' },
      { projectId: 'test-project' },
    )

    expect(result.requestedProvider).toBe('claude_desktop')
    expect(result.executedProvider).toBe('codex_local')
    expect(result.providerFallbackApplied).toBe(true)
    expect(result.text).toBe('codex recovered')
  })

  it('falls back from claude desktop when the desktop path times out', async () => {
    vi.useFakeTimers()
    try {
      mockProjectSettingsById['test-project'] = {
        execution_provider: 'claude_desktop',
        execution_provider_secondary: 'codex_local',
        fallback_policy: 'enabled',
        model_tier: 'balanced',
      }

      mockQuery.mockImplementation(({ options }: any) => ({
        async *[Symbol.asyncIterator]() {
          const signal: AbortSignal | undefined = options?.abortController?.signal
          if (!signal) throw new Error('missing abort controller')
          yield { type: 'system', subtype: 'init', sessionId: 'claude-session', model: 'claude-desktop' }
          await new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        },
      }))

      mockSpawnSuccess(undefined, 'codex recovered after timeout')

      const runPromise = runAgentWithResolvedExecution(
        { prompt: 'hello' },
        { projectId: 'test-project' },
      )

      await vi.advanceTimersByTimeAsync(600000)
      const { result } = await runPromise

      expect(result.requestedProvider).toBe('claude_desktop')
      expect(result.executedProvider).toBe('codex_local')
      expect(result.providerFallbackApplied).toBe(true)
      expect(result.text).toBe('codex recovered after timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the agent-configured fallback provider when automatic fallback is enabled', async () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'anthropic_api',
      fallback_policy: 'enabled',
      model_tier: 'balanced',
    }
    mockCredentials['test-project:anthropic:api_key'] = 'anthropic-key'
    mockCredentials['test-project:openai:api_key'] = 'openai-key'

    writeFileSync(
      join(TEST_DIR, 'projects', 'test-project', 'agents', 'builder.md'),
      `---
id: builder
name: Builder
provider_mode: inherit
provider: openai_api
---
`,
      'utf-8',
    )

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: { message: 'anthropic down' } }),
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          output_text: 'openai recovered',
          usage: { input_tokens: 20, output_tokens: 5 },
        }),
      }))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = await runAgentWithResolvedExecution(
      { prompt: 'hello' },
      { projectId: 'test-project', projectSlug: 'test-project', agentId: 'builder' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/v1/responses')
    expect(result.requestedProvider).toBe('anthropic_api')
    expect(result.executedProvider).toBe('openai_api')
    expect(result.providerFallbackApplied).toBe(true)
    expect(result.text).toBe('openai recovered')
  })

  it('does not auto-fallback when policy is disabled', async () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'openai_api',
      fallback_policy: 'disabled',
      model_tier: 'balanced',
    }
    mockCredentials['test-project:openai:api_key'] = 'openai-key'

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: 'rate limit' } }),
      })),
    )

    await expect(
      runAgentWithResolvedExecution(
        { prompt: 'hello' },
        { projectId: 'test-project' },
      ),
    ).rejects.toThrow(/OpenAI API request failed/)
  })

  it('auto-falls back when a legacy override policy is supplied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: 'rate limit' } }),
      })),
    )

    mockQuery.mockImplementation(() => (async function* () {
      yield { type: 'system', subtype: 'init', sessionId: 'claude-session', model: 'claude-desktop' }
      yield { type: 'result', result: 'fallback from override', subtype: 'success' }
    })())

    const { result } = await runAgentWithResolvedExecution(
      { prompt: 'hello' },
      {
        executionOverride: {
          provider: 'openai_api',
          fallbackPolicy: 'auto_on_error',
          fallbackProvider: 'claude_desktop',
        },
      },
    )

    expect(result.requestedProvider).toBe('openai_api')
    expect(result.executedProvider).toBe('claude_desktop')
    expect(result.providerFallbackApplied).toBe(true)
    expect(result.text).toBe('fallback from override')
  })

  it('tries the secondary provider stage before the fallback stage', async () => {
    mockProjectSettingsById['test-project'] = {
      execution_provider: 'anthropic_api',
      execution_provider_secondary: 'openai_api',
      execution_provider_fallback: 'claude_desktop',
      execution_model_primary: 'claude-sonnet-4-6',
      execution_model_secondary: 'gpt-5-mini',
      fallback_policy: 'enabled',
      model_tier: 'balanced',
    }
    mockCredentials['test-project:anthropic:api_key'] = 'anthropic-key'
    mockCredentials['test-project:openai:api_key'] = 'openai-key'

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: { message: 'primary provider failed' } }),
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          output_text: 'secondary recovered',
          usage: { input_tokens: 20, output_tokens: 5 },
        }),
      }))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = await runAgentWithResolvedExecution(
      { prompt: 'hello' },
      { projectId: 'test-project' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/v1/messages')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/v1/responses')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? '{}')).model).toBe('claude-sonnet-4-6')
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? '{}')).model).toBe('gpt-5-mini')
    expect(result.executedProvider).toBe('openai_api')
    expect(result.providerFallbackApplied).toBe(true)
    expect(result.text).toBe('secondary recovered')
  })
})

function mockSpawnSuccess(
  assertFn?: (ctx: { file: string; args: string[]; stdinEnd: ReturnType<typeof vi.fn> }) => void,
  stdout = 'ok',
  stderr = '',
) {
  mockSpawn.mockImplementation((file: string, args: string[]) => {
    const child: any = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const stdinEnd = vi.fn()
    child.stdin = { end: stdinEnd }
    child.kill = vi.fn()
    assertFn?.({ file, args, stdinEnd })
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout))
      if (stderr) child.stderr.emit('data', Buffer.from(stderr))
      child.emit('close', 0, null)
    })
    return child
  })
}

function mockSpawnFailure(stderr = 'codex failed') {
  mockSpawn.mockImplementation(() => {
    const child: any = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { end: vi.fn() }
    child.kill = vi.fn()
    queueMicrotask(() => {
      if (stderr) child.stderr.emit('data', Buffer.from(stderr))
      child.emit('close', 1, null)
    })
    return child
  })
}
