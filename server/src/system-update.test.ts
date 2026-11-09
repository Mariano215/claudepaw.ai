import { describe, it, expect, vi, afterEach } from 'vitest'
import { getUpdateStatus } from './system-update.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getUpdateStatus', () => {
  it('returns behind:0 and empty commits when gitHash is null', async () => {
    const result = await getUpdateStatus(null)
    expect(result).toEqual({ behind: 0, commits: [] })
  })

  it('returns behind count and trimmed commits from GitHub API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        behind_by: 2,
        commits: [
          { sha: 'abc1234567890', commit: { message: 'feat: add feature\n\nlong body' } },
          { sha: 'def0987654321', commit: { message: 'fix: bug fix' } },
        ],
      }),
    }))
    const result = await getUpdateStatus('abc1234')
    expect(result.behind).toBe(2)
    expect(result.commits).toHaveLength(2)
    expect(result.commits[0].sha).toBe('abc1234') // first 7 chars of 'abc1234567890'
    expect(result.commits[0].message).toBe('feat: add feature') // first line only
    expect(result.commits[1].sha).toBe('def0987')
  })

  it('returns behind:0 when GitHub API returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    const result = await getUpdateStatus('abc1234')
    expect(result).toEqual({ behind: 0, commits: [] })
  })

  it('returns behind:0 when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    const result = await getUpdateStatus('abc1234')
    expect(result).toEqual({ behind: 0, commits: [] })
  })
})
