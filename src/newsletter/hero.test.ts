import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { TMP } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const p = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const o = require('node:os') as typeof import('node:os')
  return { TMP: p.join(o.tmpdir(), 'claudepaw-hero-tests') }
})

const { configRef } = vi.hoisted(() => ({
  configRef: {
    heroDir: '',
    geminiApiKey: '',
    geminiModel: 'test-model',
    maxHeroBytes: 100_000,
  },
}))

vi.mock('./config.js', () => ({
  get NEWSLETTER_CONFIG() { return configRef },
}))

import { logger } from '../logger.js'
import { buildArtPrompt, heroPathForDate, generateHeroImage, optimizeForEmail } from './hero.js'

describe('buildArtPrompt', () => {
  it('includes motifs for each provided theme', () => {
    const prompt = buildArtPrompt(['identity', 'supply_chain'])
    expect(prompt).toContain('biometric iris scans')
    expect(prompt).toContain('interconnected chain links')
  })

  it('always includes the "no text" constraint', () => {
    const prompt = buildArtPrompt(['identity'])
    expect(prompt.toLowerCase()).toContain('no text')
  })

  it('sets 21:9 aspect ratio', () => {
    const prompt = buildArtPrompt(['identity'])
    expect(prompt).toContain('21:9')
  })
})

describe('heroPathForDate', () => {
  beforeEach(() => { configRef.heroDir = TMP })
  it('returns TMP/hero-YYYY-MM-DD.png', () => {
    expect(heroPathForDate('2026-04-14')).toBe(path.join(TMP, 'hero-2026-04-14.png'))
  })
})

describe('generateHeroImage', () => {
  beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    configRef.heroDir = TMP
    configRef.geminiApiKey = ''
    configRef.geminiModel = 'test-model'
    configRef.maxHeroBytes = 100_000
  })

  it('reuses existing hero image when present (idempotent)', async () => {
    const target = heroPathForDate('2026-01-01')
    writeFileSync(target, 'fake-png')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateHeroImage(['identity'], '2026-01-01')
    expect(result.imagePath).toBe(target)
    expect(result.fallbackReason).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns fallback with reason=no-api-key when API key is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await generateHeroImage(['identity'], '2026-01-02')
    expect(result.artDirection).toBe('fallback')
    expect(result.fallbackReason).toBe('no-api-key')
    expect(fetchMock).not.toHaveBeenCalled()
    // Operator must actually see why we fell back.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('GEMINI_API_KEY not set'),
    )
  })

  it('writes the returned image bytes to disk when Gemini returns data', async () => {
    configRef.geminiApiKey = 'k'
    const png = Buffer.from('fake-png-bytes').toString('base64')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ inlineData: { data: png } }] } }],
      }),
      text: async () => '',
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await generateHeroImage(['identity'], '2026-01-03')
    const expected = heroPathForDate('2026-01-03')
    expect(result.imagePath).toBe(expected)
    expect(result.fallbackReason).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(existsSync(expected)).toBe(true)
    expect(readFileSync(expected).toString()).toBe('fake-png-bytes')
  })

  it('returns fallback with reason=api-error when Gemini responds non-ok', async () => {
    configRef.geminiApiKey = 'k'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => 'upstream exploded',
      json: async () => ({}),
    })))
    const result = await generateHeroImage(['identity'], '2026-01-04')
    expect(result.fallbackReason).toBe('api-error')
    expect(logger.error).toHaveBeenCalled()
  })

  it('returns fallback with reason=no-image-in-response when no inlineData', async () => {
    configRef.geminiApiKey = 'k'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'refusal' }] } }] }),
      text: async () => '',
    })))
    const result = await generateHeroImage(['identity'], '2026-01-05')
    expect(result.fallbackReason).toBe('no-image-in-response')
    expect(logger.error).toHaveBeenCalledWith('Gemini response contained no image data')
  })

  it('returns fallback with reason=thrown when fetch rejects', async () => {
    configRef.geminiApiKey = 'k'
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ENETDOWN') }))
    const result = await generateHeroImage(['identity'], '2026-01-06')
    expect(result.fallbackReason).toBe('thrown')
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('optimizeForEmail', () => {
  beforeEach(() => { configRef.heroDir = TMP })

  it('returns empty string when imagePath missing', async () => {
    const result = await optimizeForEmail('')
    expect(result).toBe('')
  })

  it('returns empty string when file does not exist', async () => {
    const result = await optimizeForEmail('/tmp/does-not-exist-12345.png')
    expect(result).toBe('')
  })
})
