import { describe, it, expect } from 'vitest'
import { isPaywallHost, checkPaywallMarkers, checkBlockMarkers } from './prober.js'

describe('isPaywallHost', () => {
  it('detects known paywall hosts', () => {
    expect(isPaywallHost('https://www.wsj.com/article/test')).toBe(true)
    expect(isPaywallHost('https://ft.com/content/something')).toBe(true)
    expect(isPaywallHost('https://www.nytimes.com/2026/04/article')).toBe(true)
  })

  it('passes non-paywall hosts', () => {
    expect(isPaywallHost('https://krebsonsecurity.com/2026/04/post')).toBe(false)
    expect(isPaywallHost('https://darkreading.com/article')).toBe(false)
  })
})

describe('checkPaywallMarkers', () => {
  it('detects paywall markers in HTML', () => {
    const html = '<div class="paywall">Subscribe to continue reading this article.</div>'
    expect(checkPaywallMarkers(html)).toBe(true)
  })

  it('passes clean HTML', () => {
    const html = '<div><h1>Article Title</h1><p>Normal content here.</p></div>'
    expect(checkPaywallMarkers(html)).toBe(false)
  })
})

describe('checkBlockMarkers', () => {
  it('detects access denied', () => {
    const html = '<html><body><h1>403 Forbidden</h1><p>Access Denied</p></body></html>'
    expect(checkBlockMarkers(html)).toBe(true)
  })

  it('detects captcha', () => {
    const html = '<div>Please verify you are human by completing the captcha below.</div>'
    expect(checkBlockMarkers(html)).toBe(true)
  })

  it('passes normal pages', () => {
    const html = '<html><body><article>Normal article content.</article></body></html>'
    expect(checkBlockMarkers(html)).toBe(false)
  })
})
