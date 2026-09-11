import { describe, it, expect, vi, beforeEach } from 'vitest'

const sheetRows: string[][] = [
  ['Festival', 'Deadline', 'Status'],
  ['Slamdance', '2026-10-01', 'submitted'],
]
let readExample FilmImpl: () => Promise<string[][]> = async () => sheetRows
vi.mock('../../../projects/example-company/task-context.js', () => ({
  readExample FilmFestivalRows: vi.fn(() => readExample FilmImpl()),
}))

const seenIds: string[] = []
vi.mock('../../../db.js', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => ({ findings: JSON.stringify(seenIds.map(id => ({ id, severity: 3, title: id, detail: '', is_new: true }))) }),
    }),
  }),
}))

vi.mock('../../../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const RSS = `<?xml version="1.0"?><rss><channel>
  <item><title>Blackbird Film Festival opens 2026 submissions</title><link>https://example.com/a</link><pubDate>Mon, 08 Sep 2026 10:00:00 GMT</pubDate><description>d</description></item>
  <item><title>Blackbird Film Festival opens 2026 submissions</title><link>https://example.com/a?utm_source=x</link><pubDate>Mon, 08 Sep 2026 10:00:00 GMT</pubDate><description>d</description></item>
</channel></rss>`

beforeEach(() => {
  seenIds.length = 0
  readExample FilmImpl = async () => sheetRows
  vi.stubGlobal('fetch', vi.fn(async () => new Response(RSS, { status: 200 })))
})

describe('fo-festivals collector', () => {
  it('dedupes the same article across queries', async () => {
    const { foFestivalsCollector } = await import('../fo-festivals.js')
    const res = await foFestivalsCollector({ pawId: 'fo-festival-tracker', projectId: 'example-company' })
    const raw = res.raw_data as { candidates: Array<{ id: string }> }
    expect(raw.candidates).toHaveLength(1)
  })

  it('marks a candidate already reported in the previous cycle as seen', async () => {
    const { foFestivalsCollector } = await import('../fo-festivals.js')
    const first = await foFestivalsCollector({ pawId: 'fo-festival-tracker', projectId: 'example-company' })
    const id = (first.raw_data as { candidates: Array<{ id: string }> }).candidates[0].id
    seenIds.push(id)
    const second = await foFestivalsCollector({ pawId: 'fo-festival-tracker', projectId: 'example-company' })
    const raw = second.raw_data as { candidates: Array<{ seen: boolean }> }
    expect(raw.candidates[0].seen).toBe(true)
  })

  it('carries the tracker rows and records a feed error without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    const { foFestivalsCollector } = await import('../fo-festivals.js')
    const res = await foFestivalsCollector({ pawId: 'fo-festival-tracker', projectId: 'example-company' })
    const raw = res.raw_data as { tracker_rows: string[][]; candidates: unknown[] }
    expect(raw.tracker_rows).toEqual(sheetRows)
    expect(raw.candidates).toEqual([])
    expect(res.errors?.length).toBeGreaterThan(0)
  })

  it('records a tracker read failure without throwing when the RSS path still succeeds', async () => {
    readExample FilmImpl = async () => { throw new Error('sheet unreachable') }
    const { foFestivalsCollector } = await import('../fo-festivals.js')
    const res = await foFestivalsCollector({ pawId: 'fo-festival-tracker', projectId: 'example-company' })
    const raw = res.raw_data as { tracker_rows: string[][]; candidates: unknown[] }
    expect(raw.tracker_rows).toEqual([])
    expect(raw.candidates.length).toBeGreaterThan(0)
    expect(res.errors).toEqual(['tracker sheet: sheet unreachable'])
  })
})
