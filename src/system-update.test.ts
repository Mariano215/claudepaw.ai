import { describe, it, expect, vi, afterEach } from 'vitest'
import { getCommitsBehind, checkAndUpgrade } from './system-update.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('getCommitsBehind', () => {
  it('returns 0 when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    const result = await getCommitsBehind('abc1234')
    expect(result).toBe(0)
  })

  it('returns 0 when response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const result = await getCommitsBehind('abc1234')
    expect(result).toBe(0)
  })

  it('returns behind_by value from GitHub API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ behind_by: 5 }),
    }))
    const result = await getCommitsBehind('abc1234')
    expect(result).toBe(5)
  })
})

describe('checkAndUpgrade', () => {
  it('does not call runUpgrade when up to date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ behind_by: 0 }),
    }))
    const runUpgrade = vi.fn()
    const result = await checkAndUpgrade('abc1234', runUpgrade)
    expect(runUpgrade).not.toHaveBeenCalled()
    expect(result).toEqual({ behind: 0, upgraded: false })
  })

  it('calls runUpgrade when behind main', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ behind_by: 3 }),
    }))
    const runUpgrade = vi.fn()
    const result = await checkAndUpgrade('abc1234', runUpgrade)
    expect(runUpgrade).toHaveBeenCalledOnce()
    expect(result).toEqual({ behind: 3, upgraded: true })
  })

  it('returns upgraded:false and does not throw when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')))
    const runUpgrade = vi.fn()
    const result = await checkAndUpgrade('abc1234', runUpgrade)
    expect(runUpgrade).not.toHaveBeenCalled()
    expect(result).toEqual({ behind: 0, upgraded: false })
  })
})
