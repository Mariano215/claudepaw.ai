import { describe, it, expect, vi, beforeEach } from 'vitest'

const fakeAuth = { fake: 'auth' }

vi.mock('../../integrations/google/client.js', () => ({
  GoogleClient: function GoogleClient(this: { ensureFreshToken: () => Promise<typeof fakeAuth> }) {
    this.ensureFreshToken = async () => fakeAuth
  },
}))

const sheetsRead = vi.fn(async (_auth: unknown, spreadsheetId: string, range: string) => {
  if (spreadsheetId === 'YOUR_SHEET_ID_HERE') {
    return [['Festival', 'Deadline', 'Status'], ['Slamdance', '2026-10-01', 'submitted']]
  }
  return [['NOW row']]
})

vi.mock('../../integrations/google/sheets.js', () => ({
  SheetsModule: function SheetsModule(this: { read: typeof sheetsRead }) {
    this.read = sheetsRead
  },
}))

vi.mock('../../integrations/engine.js', () => ({
  IntegrationEngine: function IntegrationEngine(this: { register: () => void }) {
    this.register = () => {}
  },
}))

vi.mock('../../integrations/google/manifest.js', () => ({ googleManifest: {} }))

beforeEach(() => {
  sheetsRead.mockClear()
})

describe('buildExampleCompanyTaskContext(fop-weekly-blog-draft)', () => {
  it('reads the Example Film festival rows exactly once, through the shared reader', async () => {
    const { buildExampleCompanyTaskContext } = await import('./task-context.js')
    const context = await buildExampleCompanyTaskContext('fop-weekly-blog-draft')

    const evelynCalls = sheetsRead.mock.calls.filter(
      (call) => call[1] === 'YOUR_SHEET_ID_HERE',
    )
    expect(evelynCalls).toHaveLength(1)
    expect(context).toContain('Slamdance')
  })
})
