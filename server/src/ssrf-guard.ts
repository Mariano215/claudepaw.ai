// server/src/ssrf-guard.ts -- SSRF guard for outbound webhook delivery (dashboard).
//
// Kept in sync with src/webhooks/ssrf-guard.ts (bot tree). The two trees build
// and deploy independently (server/ rsyncs to Hostinger; bot runs on the Mac)
// and pin different undici majors, so the helper is intentionally duplicated
// rather than shared. Keep both copies identical.
//
// Closes the webhook SSRF holes:
//  - resolve + validate + PIN DNS at connect time (no TOCTOU / DNS-rebind window)
//  - reject private / loopback / link-local / CGNAT(Tailscale) / ULA / metadata
//    destinations for BOTH IPv4 and IPv6 (incl. IPv4-mapped IPv6)
//  - enforce an http/https scheme allowlist
//  - re-validate EVERY redirect hop (redirects are followed manually, capped)

import { isIP } from 'node:net'
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import { Agent, fetch as undiciFetch, type RequestInit, type Response } from 'undici'

const MAX_REDIRECTS = 5

// --------------------------------------------------------------------------
// Address classification
// --------------------------------------------------------------------------

/** True if the IP literal points at a non-public / internal destination. */
export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip)
  if (fam === 4) return isBlockedV4(ip)
  if (fam === 6) return isBlockedV6(ip)
  return true // not a valid IP literal -> treat as unsafe
}

function isBlockedV4(ip: string): boolean {
  const o = ip.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b, c] = o
  if (a === 0) return true                              // 0.0.0.0/8 "this host"
  if (a === 10) return true                             // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true     // 100.64.0.0/10 CGNAT (Tailscale)
  if (a === 127) return true                            // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true               // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true      // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true               // 192.168.0.0/16 private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true  // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true   // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true    // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true                             // 224/4 multicast, 240/4 reserved, 255.* broadcast
  return false
}

function isBlockedV6(ip: string): boolean {
  const h = expandV6(ip)
  if (!h) return true

  // IPv4-mapped (::ffff:a.b.c.d) -> validate the embedded v4 address.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    const v4 = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`
    return isBlockedV4(v4)
  }

  if (h.every((x) => x === 0)) return true // :: unspecified
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 &&
      h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] === 1) return true // ::1 loopback

  const first = h[0]
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/** Expand an IPv6 string to 8 numeric hextets, or null if malformed. */
function expandV6(ip: string): number[] | null {
  let s = ip
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone) // drop %eth0 scope id

  // Embedded IPv4 tail (e.g. ::ffff:1.2.3.4) -> fold into two hextets.
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':')
    const tail = s.slice(lastColon + 1)
    if (isIP(tail) === 4) {
      const o = tail.split('.').map(Number)
      const h1 = ((o[0] << 8) | o[1]).toString(16)
      const h2 = ((o[2] << 8) | o[3]).toString(16)
      s = `${s.slice(0, lastColon + 1)}${h1}:${h2}`
    } else {
      return null
    }
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : []

  let parts: string[]
  if (halves.length === 1) {
    if (head.length !== 8) return null
    parts = head
  } else {
    const missing = 8 - head.length - tail.length
    if (missing < 1) return null // "::" must stand in for at least one hextet
    parts = [...head, ...new Array(missing).fill('0'), ...tail]
  }
  if (parts.length !== 8) return null

  const out: number[] = []
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null
    out.push(parseInt(p, 16))
  }
  return out
}

// --------------------------------------------------------------------------
// URL validation
// --------------------------------------------------------------------------

/**
 * Validate a webhook URL: enforce http/https and reject literal internal IPs
 * and obvious internal hostnames. Throws on rejection. Does NOT resolve DNS
 * (that happens at connect time in `safeFetch`); safe to call at create time.
 */
export function assertPublicUrl(urlStr: string | URL): URL {
  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    throw new Error('Invalid webhook URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Webhook URL scheme not allowed: ${url.protocol}`)
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('Webhook URL targets localhost')
  }
  if (host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Webhook URL targets an internal host')
  }
  if (isIP(host) !== 0 && isBlockedIp(host)) {
    throw new Error(`Webhook URL targets a private address: ${host}`)
  }
  return url
}

// --------------------------------------------------------------------------
// Pinned, validating dispatcher
// --------------------------------------------------------------------------

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

function validatingLookup(hostname: string, options: LookupOptions, callback: LookupCb): void {
  // Always resolve every record so we can reject if ANY maps to an internal
  // address (defeats round-robin rebind). `all: true` is forced regardless of
  // what undici asked for; we just shape the reply to match `options.all`.
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err, [])
      return
    }
    const list = addresses as LookupAddress[]
    for (const a of list) {
      if (isBlockedIp(a.address)) {
        callback(new Error(`SSRF blocked: ${hostname} resolves to internal address ${a.address}`), [])
        return
      }
    }
    if (options.all) {
      callback(null, list)
    } else {
      callback(null, list[0].address, list[0].family)
    }
  })
}

// One shared dispatcher. Its lookup validates + pins every TCP connect, so even
// redirects undici might follow internally are checked at connect time.
const pinnedAgent = new Agent({ connect: { lookup: validatingLookup } })

// --------------------------------------------------------------------------
// safeFetch -- drop-in replacement for fetch() on the webhook delivery paths
// --------------------------------------------------------------------------

/**
 * SSRF-safe fetch for webhook delivery. Validates the URL, pins DNS at connect,
 * and follows redirects manually (capped), re-validating each hop. Accepts the
 * same options the call sites already pass (method, headers, body, signal).
 */
export async function safeFetch(urlStr: string, init: RequestInit = {}): Promise<Response> {
  let current: URL = assertPublicUrl(urlStr)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const resp = await undiciFetch(current.href, {
      ...init,
      redirect: 'manual',
      dispatcher: pinnedAgent,
    })

    const location = resp.status >= 300 && resp.status < 400 ? resp.headers.get('location') : null
    if (!location) return resp

    // Drain the redirect body so the socket is freed before the next hop.
    await resp.body?.cancel().catch(() => {})
    current = assertPublicUrl(new URL(location, current))
  }

  throw new Error(`SSRF guard: webhook exceeded ${MAX_REDIRECTS} redirects`)
}
