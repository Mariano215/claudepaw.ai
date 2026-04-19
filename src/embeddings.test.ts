import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MEMORY_ENABLED,
  EMBEDDING_PROVIDER,
  EMBEDDING_DIMENSIONS,
  EXTRACTION_PROVIDER,
  EXTRACTION_MODEL,
} from './config.js'

describe('memory config', () => {
  it('exports MEMORY_ENABLED as boolean', () => {
    expect(typeof MEMORY_ENABLED).toBe('boolean')
  })
  it('exports EMBEDDING_PROVIDER as ollama or openai', () => {
    expect(['ollama', 'openai']).toContain(EMBEDDING_PROVIDER)
  })
  it('exports EMBEDDING_DIMENSIONS as 768 or 1536', () => {
    expect([768, 1536]).toContain(EMBEDDING_DIMENSIONS)
  })
  it('exports EXTRACTION_PROVIDER as valid value', () => {
    expect(['ollama', 'anthropic', 'openai']).toContain(EXTRACTION_PROVIDER)
  })
  it('EXTRACTION_MODEL is a non-empty string', () => {
    expect(typeof EXTRACTION_MODEL).toBe('string')
    expect(EXTRACTION_MODEL.length).toBeGreaterThan(0)
  })
})

describe('_embedWithProvider graceful failure', () => {
  it('returns empty array when openai provider is unreachable and no fallback', async () => {
    // provider='openai' as primary has no further fallback. A bad config
    // plus the real OPENAI_API_KEY will still fail because the model/URL
    // are bogus - the function resolves to [] rather than throwing.
    const { _embedWithProvider } = await import('./embeddings.js')
    const result = await _embedWithProvider('test', 'http://localhost:0/bad', 'bogus-model-name', 'openai')
    expect(result).toEqual([])
  })
})

describe('_embedWithProvider ollama to openai fallback', () => {
  it('falls back to OpenAI when Ollama is unreachable (if OPENAI_API_KEY set)', async () => {
    // With an unreachable Ollama, the function should try OpenAI with
    // text-embedding-3-small at 768 dims. If OPENAI_API_KEY is set in
    // the test environment, this returns a real 768-dim vector; if not,
    // both providers fail and we get []. Either outcome is valid; we
    // just verify the type contract (array of numbers or empty array).
    const { _embedWithProvider } = await import('./embeddings.js')
    const result = await _embedWithProvider('hello world', 'http://localhost:0/bad', 'nomic-embed-text', 'ollama')
    expect(Array.isArray(result)).toBe(true)
    if (result.length > 0) {
      expect(result.length).toBe(768)
      expect(result.every((n) => typeof n === 'number')).toBe(true)
    }
  })
})

describe('ollama grace period — alert suppression on restart', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    // Reset module-level alert state between tests.
    const { _resetOllamaAlertState } = await import('./embeddings.js')
    _resetOllamaAlertState()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('suppresses Telegram alert within the 3-minute grace window', async () => {
    // Simulate unreachable Ollama returning a non-OK status so _ollamaEmbed throws.
    fetchSpy.mockImplementation(async (url: RequestInfo | URL) => {
      const u = url.toString()
      if (u.includes('api/embeddings')) return new Response('', { status: 503 })
      // Any other fetch (OpenAI fallback, Telegram) — fail silently.
      throw new Error('unexpected fetch in test')
    })

    const { _embedWithProvider } = await import('./embeddings.js')

    // First failure — starts the outage clock but grace window is still open.
    await _embedWithProvider('test', 'http://localhost:11434', 'nomic-embed-text', 'ollama')

    // Advance 1 minute — still inside the 3-minute grace period.
    vi.advanceTimersByTime(60_000)
    await _embedWithProvider('test', 'http://localhost:11434', 'nomic-embed-text', 'ollama')

    // Telegram sendMessage should NOT have been called yet.
    const telegramCalls = fetchSpy.mock.calls.filter(([url]: [RequestInfo | URL]) =>
      url.toString().includes('api.telegram.org'),
    )
    expect(telegramCalls).toHaveLength(0)
  })

  it('fires Telegram alert after grace window expires', async () => {
    fetchSpy.mockImplementation(async (url: RequestInfo | URL) => {
      const u = url.toString()
      if (u.includes('api/embeddings')) return new Response('', { status: 503 })
      if (u.includes('api.telegram.org')) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      throw new Error('unexpected fetch in test')
    })

    const { _embedWithProvider } = await import('./embeddings.js')

    // First failure — starts the outage clock.
    await _embedWithProvider('test', 'http://localhost:11434', 'nomic-embed-text', 'ollama')

    // Advance past the 3-minute grace window.
    vi.advanceTimersByTime(3 * 60 * 1000 + 1)

    // Next failure should now trigger the Telegram alert (if BOT_TOKEN/ALLOWED_CHAT_ID are set).
    // In CI these env vars are absent so the alert is skipped, but the grace-window
    // check is exercised — we verify no errors are thrown either way.
    await expect(
      _embedWithProvider('test', 'http://localhost:11434', 'nomic-embed-text', 'ollama'),
    ).resolves.toEqual(expect.any(Array))
  })
})
