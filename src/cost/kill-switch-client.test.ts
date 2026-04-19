import { describe, it, expect, beforeEach, vi } from 'vitest'
import { checkKillSwitch, _resetCache } from './kill-switch-client.js'

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

describe('checkKillSwitch', () => {
  beforeEach(() => {
    _resetCache()
    vi.restoreAllMocks()
  })

  it('returns null when dashboard says not active', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: false }),
    }))

    const result = await checkKillSwitch()
    expect(result).toBeNull()
  })

  it('returns KillSwitchInfo when dashboard says active', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: true, reason: 'spike', set_at: 123 }),
    }))

    const result = await checkKillSwitch()
    expect(result).toEqual({ reason: 'spike', set_at: 123 })
  })

  it('uses cache on second call within 15s (fetch called once)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: false }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await checkKillSwitch()
    await checkKillSwitch()

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('returns stale tripped value on network failure after prior tripped response', async () => {
    // First call: tripped
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: true, reason: 'spike', set_at: 123 }),
    }))
    await checkKillSwitch()

    // Expire the TTL cache but keep staleCache
    _resetCache({ keepStale: true })
    vi.restoreAllMocks()

    // Second call: network failure
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))

    const result = await checkKillSwitch()
    expect(result).toEqual({ reason: 'spike', set_at: 123 })
  })
})
