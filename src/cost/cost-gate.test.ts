import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getCostGateStatus, _resetCache, type CostGateStatus } from './cost-gate.js'

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const FAIL_OPEN: CostGateStatus = {
  action: 'allow',
  percent_of_cap: 0,
  mtd_usd: 0,
  today_usd: 0,
  monthly_cap_usd: null,
  daily_cap_usd: null,
  triggering_cap: null,
}

describe('getCostGateStatus', () => {
  beforeEach(() => {
    _resetCache()
    vi.restoreAllMocks()
  })

  it('returns server JSON verbatim on success', async () => {
    const serverResponse: CostGateStatus = {
      action: 'refuse',
      percent_of_cap: 105,
      mtd_usd: 52.5,
      today_usd: 3.1,
      monthly_cap_usd: 50,
      daily_cap_usd: 5,
      triggering_cap: 'monthly',
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => serverResponse,
    }))

    const result = await getCostGateStatus('default')
    expect(result).toEqual(serverResponse)
  })

  it('returns FAIL_OPEN on fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))

    const result = await getCostGateStatus('default')
    expect(result).toEqual(FAIL_OPEN)
  })

  it('returns FAIL_OPEN on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal server error' }),
    }))

    const result = await getCostGateStatus('default')
    expect(result).toEqual(FAIL_OPEN)
  })

  it('reuses cache on 2nd call within 60s (fetch called once)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        action: 'allow',
        percent_of_cap: 42,
        mtd_usd: 21,
        today_usd: 1.5,
        monthly_cap_usd: 50,
        daily_cap_usd: null,
        triggering_cap: null,
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await getCostGateStatus('default')
    await getCostGateStatus('default')

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('uses separate cache entries per projectId', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...FAIL_OPEN, percent_of_cap: 10 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...FAIL_OPEN, percent_of_cap: 80 }),
      })
    vi.stubGlobal('fetch', mockFetch)

    const r1 = await getCostGateStatus('project-a')
    const r2 = await getCostGateStatus('project-b')

    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(r1.percent_of_cap).toBe(10)
    expect(r2.percent_of_cap).toBe(80)
  })
})
