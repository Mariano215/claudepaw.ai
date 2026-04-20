import { describe, it, expect, vi } from 'vitest'

// Mock static-map so tests don't hit OSM.
vi.mock('./static-map.js', () => ({
  renderStaticMap: vi.fn(async () => Buffer.from('fake-map-png')),
}))

import { renderReport } from './render.js'
import type { PropertyFinding } from './render.js'

function sample(partial: Partial<PropertyFinding> = {}): PropertyFinding {
  return {
    id: '3947-mary-st-19026',
    address: '3947 Mary St, Drexel Hill, PA 19026',
    zip: '19026',
    price: 225000,
    beds: 2,
    baths: 1,
    sqft: 1236,
    property_type: 'Multi-Family',
    days_on_market: 33,
    severity: 4,
    title: '3947 Mary St -- $225,000',
    why_flagged: 'Multi-family under $250k, 33 DOM suggests seller flexibility',
    est_rent_per_mo: 2190,
    arv_estimate: 303750,
    max_offer_70_pct: 212625,
    deal_verdict: 'stretch',
    latitude: 39.936027,
    longitude: -75.294048,
    sources: ['rentcast'],
    listing_url: 'https://www.zillow.com/homedetails/3947-Mary-St/1234_zpid/',
    ...partial,
  }
}

describe('renderReport', () => {
  it('includes all properties with cid-referenced maps', async () => {
    const res = await renderReport({
      report_date: '2026-04-20',
      properties: [sample(), sample({ id: 'b', address: '1 Other St' })],
    })
    expect(res.inlineImages).toHaveLength(2)
    expect(res.inlineImages[0].cid).toBe('map-0')
    expect(res.inlineImages[1].cid).toBe('map-1')
    expect(res.html).toContain('src="cid:map-0"')
    expect(res.html).toContain('src="cid:map-1"')
    expect(res.html).toContain('3947 Mary St')
  })

  it('sorts properties by severity descending', async () => {
    const res = await renderReport({
      report_date: '2026-04-20',
      properties: [
        sample({ id: 'low', address: 'Low St', severity: 2, title: 'Low St' }),
        sample({ id: 'hi', address: 'Hi St', severity: 5, title: 'Hi St' }),
        sample({ id: 'mid', address: 'Mid St', severity: 3, title: 'Mid St' }),
      ],
    })
    const idxHi = res.html.indexOf('Hi St')
    const idxMid = res.html.indexOf('Mid St')
    const idxLow = res.html.indexOf('Low St')
    expect(idxHi).toBeLessThan(idxMid)
    expect(idxMid).toBeLessThan(idxLow)
  })

  it('escapes user-provided strings to prevent HTML injection', async () => {
    const res = await renderReport({
      report_date: '2026-04-20',
      properties: [
        sample({
          title: '<script>alert(1)</script>',
          address: '"><img src=x>',
          why_flagged: 'normal text',
        }),
      ],
    })
    expect(res.html).not.toContain('<script>alert(1)</script>')
    expect(res.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // The injection attempt should be escaped
    expect(res.html).not.toContain('"><img src=x>')
    expect(res.html).toContain('&quot;&gt;&lt;img src=x&gt;')
  })

  it('subject line reflects property count', async () => {
    const zero = await renderReport({
      report_date: '2026-04-20',
      properties: [],
    })
    expect(zero.subject).toContain('0 fixer-uppers')

    const one = await renderReport({
      report_date: '2026-04-20',
      properties: [sample()],
    })
    expect(one.subject).toContain('1 fixer-upper --')
    expect(one.subject).not.toContain('1 fixer-uppers')
  })

  it('gracefully handles missing optional fields', async () => {
    const res = await renderReport({
      report_date: '2026-04-20',
      properties: [
        sample({
          beds: null,
          baths: null,
          sqft: null,
          days_on_market: null,
          est_rent_per_mo: null,
          arv_estimate: null,
          max_offer_70_pct: null,
          deal_verdict: null,
          listing_url: null,
        }),
      ],
    })
    expect(res.html).toContain('3947 Mary St')
    // Should fall back to Zillow search URL
    expect(res.html).toContain('zillow.com')
  })

  it('does not contain any legacy Google Static Maps URLs', async () => {
    const res = await renderReport({
      report_date: '2026-04-20',
      properties: [sample()],
    })
    expect(res.html).not.toContain('maps.googleapis.com')
    expect(res.html).not.toContain('staticmap')
    expect(res.html).not.toContain('AIzaSy')
  })
})
