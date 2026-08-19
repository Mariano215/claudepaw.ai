import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./config.js', () => ({
  DASHBOARD_URL: 'http://dashboard.test',
  BOT_API_TOKEN: 'test-bot-token',
}))

const { buildMetricHealthContext } = await import('./metric-health-context.js')

const row = (over: Record<string, unknown> = {}) => ({
  integration_id: 2,
  project_id: 'default',
  platform: 'linkedin',
  metric_prefix: 'ms-linkedin',
  status: 'failing',
  attempts: 1,
  last_success: null,
  reason: 'LinkedIn API 401: EXPIRED',
  missing_keys: '[]',
  ...over,
})

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
}

beforeEach(() => { vi.stubGlobal('fetch', mockFetch(200, [])) })
afterEach(() => { vi.unstubAllGlobals() })

describe('buildMetricHealthContext', () => {
  it('sends the bot token to the degraded endpoint', async () => {
    const f = mockFetch(200, [])
    vi.stubGlobal('fetch', f)
    await buildMetricHealthContext()
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://dashboard.test/api/v1/metric-health/degraded')
    expect(init.headers['x-dashboard-token']).toBe('test-bot-token')
  })

  it('reports the all-healthy line when nothing is degraded', async () => {
    const out = await buildMetricHealthContext()
    expect(out).toContain('All integrations healthy')
  })

  // The bug this whole module exists to prevent: a run that cannot see the
  // data must not be able to claim health.
  it('throws rather than returning an all-clear when the fetch fails', async () => {
    vi.stubGlobal('fetch', mockFetch(401, {}))
    await expect(buildMetricHealthContext()).rejects.toThrow('401')
  })

  it('groups rows by project and flags escalation past the attempts threshold', async () => {
    vi.stubGlobal('fetch', mockFetch(200, [
      row({ attempts: 273 }),
      row({ project_id: 'example-company', platform: 'website', attempts: 2, integration_id: 15 }),
    ]))
    const out = await buildMetricHealthContext()
    expect(out).toContain('default')
    expect(out).toContain('example-company')
    const lines = out!.split('\n')
    const escalated = lines.find((l) => l.includes('attempts=273'))!
    const belowThreshold = lines.find((l) => l.includes('attempts=2,'))!
    expect(escalated).toContain('ESCALATED')       // 273 >= 5
    expect(belowThreshold).not.toContain('ESCALATED')
    expect(out).toContain('never succeeded')
    expect(out).toContain('Do not re-fetch')
  })

  it('surfaces missing metric keys so the agent can name them', async () => {
    vi.stubGlobal('fetch', mockFetch(200, [
      row({ missing_keys: '["ms-linkedin-followers"]' }),
    ]))
    const out = await buildMetricHealthContext()
    expect(out).toContain('ms-linkedin-followers')
  })
})
