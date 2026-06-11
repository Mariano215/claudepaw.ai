import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Config must be mocked BEFORE importing the module under test.
vi.mock('./config.js', () => ({
  BOT_TOKEN: 'test-token',
  ALLOWED_CHAT_ID: '12345',
}))

import { sendSystemAlert, _resetSystemAlertState } from './system-alert.js'

describe('sendSystemAlert (break-glass path)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    _resetSystemAlertState()
    fetchMock.mockReset().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends plain text to the operator chat with no parse_mode', async () => {
    const sent = await sendSystemAlert('k1', 'Dashboard unreachable')
    expect(sent).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.chat_id).toBe('12345')
    expect(body.text).toContain('Dashboard unreachable')
    expect(body.parse_mode).toBeUndefined() // plain-text hard rule
  })

  it('rate-limits to one alert per key per hour, separate keys independent', async () => {
    expect(await sendSystemAlert('k1', 'a')).toBe(true)
    expect(await sendSystemAlert('k1', 'b')).toBe(false) // limited
    expect(await sendSystemAlert('k2', 'c')).toBe(true)  // separate key
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never throws when the HTTP call fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    await expect(sendSystemAlert('k1', 'x')).resolves.toBe(false)
  })
})
