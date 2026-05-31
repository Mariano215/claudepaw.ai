// src/webhooks/ssrf-guard.fetch.test.ts -- networked-path coverage for the SSRF guard.
//
// The sibling ssrf-guard.test.ts covers the pure classifier/validator against
// real modules. This file mocks `undici` and `node:dns` so the two
// security-critical runtime paths can be driven deterministically with no socket:
//   - validatingLookup  : the pinned resolver passed to the undici Agent. We
//                         capture it from `new Agent(...)` and call it directly.
//   - safeFetch         : the manual, capped, re-validating redirect loop.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted so the vi.mock factories (which are hoisted above imports) can see them.
const { fetchMock, dnsLookupMock, captured } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  dnsLookupMock: vi.fn(),
  captured: { lookup: undefined as unknown as (h: string, o: any, cb: any) => void },
}))

vi.mock('undici', () => ({
  // Capture the lookup the guard pins onto its Agent so we can unit-test it.
  Agent: class {
    constructor(opts: any) {
      captured.lookup = opts?.connect?.lookup
    }
  },
  fetch: (...args: any[]) => fetchMock(...args),
}))

vi.mock('node:dns', () => ({
  lookup: (...args: any[]) => dnsLookupMock(...args),
}))

// Import after the mocks are registered.
const { safeFetch } = await import('./ssrf-guard.js')

beforeEach(() => {
  fetchMock.mockReset()
  dnsLookupMock.mockReset()
})

// --------------------------------------------------------------------------
// validatingLookup -- the pinned resolver (captured from the Agent ctor)
// --------------------------------------------------------------------------

describe('validatingLookup (pinned resolver)', () => {
  it('was pinned onto the undici Agent at import time', () => {
    expect(typeof captured.lookup).toBe('function')
  })

  it('propagates DNS resolution errors with an empty address list', () => {
    dnsLookupMock.mockImplementation((_h, _o, cb) => cb(new Error('ENOTFOUND'), []))
    const cb = vi.fn()
    captured.lookup('nope.test', {}, cb)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(cb.mock.calls[0][1]).toEqual([])
  })

  it('rejects when ANY resolved record is an internal address (rebind defense)', () => {
    dnsLookupMock.mockImplementation((_h, _o, cb) =>
      cb(null, [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.5', family: 4 }, // private -> whole resolution rejected
      ]),
    )
    const cb = vi.fn()
    captured.lookup('rebind.test', { all: true }, cb)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(String(cb.mock.calls[0][0].message)).toContain('SSRF blocked')
    expect(cb.mock.calls[0][0].message).toContain('10.0.0.5')
    expect(cb.mock.calls[0][1]).toEqual([])
  })

  it('returns the full address list when undici asks for all', () => {
    const list = [
      { address: '8.8.8.8', family: 4 },
      { address: '1.1.1.1', family: 4 },
    ]
    dnsLookupMock.mockImplementation((_h, _o, cb) => cb(null, list))
    const cb = vi.fn()
    captured.lookup('good.test', { all: true }, cb)
    expect(cb).toHaveBeenCalledWith(null, list)
  })

  it('returns a single address+family when undici asks for one', () => {
    dnsLookupMock.mockImplementation((_h, _o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]))
    const cb = vi.fn()
    captured.lookup('good.test', {}, cb) // options.all falsy
    expect(cb).toHaveBeenCalledWith(null, '8.8.8.8', 4)
  })

  it('forces all:true + verbatim on the underlying resolver regardless of input', () => {
    dnsLookupMock.mockImplementation((_h, _o, cb) => cb(null, [{ address: '8.8.8.8', family: 4 }]))
    captured.lookup('good.test', {}, vi.fn())
    const passedOpts = dnsLookupMock.mock.calls[0][1]
    expect(passedOpts).toMatchObject({ all: true, verbatim: true })
  })
})

// --------------------------------------------------------------------------
// safeFetch -- the manual redirect loop (URL validation already unit-tested)
// --------------------------------------------------------------------------

// Minimal undici Response stand-in: safeFetch only reads status, the Location
// header, and (on redirects) body.cancel().
function fakeResponse(status: number, location: string | null, withBody = true) {
  return {
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'location' ? location : null) },
    body: withBody ? { cancel: vi.fn().mockResolvedValue(undefined) } : null,
  } as any
}

describe('safeFetch redirect loop', () => {
  it('returns a 2xx response without following anything', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, null))
    const res = await safeFetch('http://example.com/hook')
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns a 4xx response as-is (no Location to follow)', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(404, null))
    const res = await safeFetch('http://example.com/hook')
    expect(res.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns a 3xx response that carries no Location header', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(302, null))
    const res = await safeFetch('http://example.com/hook')
    expect(res.status).toBe(302)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('follows a redirect to a public target and drains the redirect body', async () => {
    const redirect = fakeResponse(302, 'http://example.org/next')
    fetchMock.mockResolvedValueOnce(redirect).mockResolvedValueOnce(fakeResponse(200, null))
    const res = await safeFetch('http://example.com/hook')
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(redirect.body.cancel).toHaveBeenCalledTimes(1) // socket freed before next hop
    // second hop targets the redirect Location
    expect(fetchMock.mock.calls[1][0]).toBe('http://example.org/next')
  })

  it('re-validates each redirect hop and rejects a redirect to an internal address', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(302, 'http://169.254.169.254/latest/meta-data/'))
    await expect(safeFetch('http://example.com/hook')).rejects.toThrow(/private address/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('resolves a relative redirect Location against the current URL', async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse(301, '/moved', false)) // null body -> exercises optional-chain skip
      .mockResolvedValueOnce(fakeResponse(200, null))
    const res = await safeFetch('http://example.com/a/b')
    expect(res.status).toBe(200)
    expect(fetchMock.mock.calls[1][0]).toBe('http://example.com/moved')
  })

  it('throws once the redirect chain exceeds the cap', async () => {
    fetchMock.mockResolvedValue(fakeResponse(302, 'http://example.com/loop'))
    await expect(safeFetch('http://example.com/hook')).rejects.toThrow(/exceeded \d+ redirects/i)
    expect(fetchMock).toHaveBeenCalledTimes(6) // MAX_REDIRECTS (5) + initial
  })
})
