// src/guard/layers/l7-ml-output.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scanMLOutput } from './l7-ml-output.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('l7-ml-output', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('returns scan result from sidecar', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        toxicityScore: 0.05,
        refusalDetected: false,
        isBlocked: false,
        blocker: null,
      }),
    })

    const result = await scanMLOutput('Here is a helpful answer.', 'What is AI?')
    expect(result.layer).toBe('l7-ml-output')
    expect(result.toxicityScore).toBe(0.05)
    expect(result.isBlocked).toBe(false)
    expect(result.degraded).toBe(false)
  })

  it('returns degraded result when sidecar unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await scanMLOutput('response', 'prompt')
    expect(result.degraded).toBe(true)
    expect(result.isBlocked).toBe(false)
  })

  it('sends both text and prompt to sidecar', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        toxicityScore: 0.0,
        refusalDetected: false,
        isBlocked: false,
        blocker: null,
      }),
    })

    await scanMLOutput('the response', 'the prompt')
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.text).toBe('the response')
    expect(body.prompt).toBe('the prompt')
  })
})
