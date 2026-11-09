// server/src/ssrf-guard.test.ts -- SSRF guard regression tests (dashboard).
// Kept in sync with src/webhooks/ssrf-guard.test.ts (bot tree).
// Covers the address classifier and URL validator (the security-critical, pure
// logic). safeFetch's network behavior is exercised only for the synchronous
// reject paths (blocked literal IPs / bad schemes never open a socket).

import { describe, it, expect } from 'vitest'
import { isBlockedIp, assertPublicUrl, safeFetch } from './ssrf-guard.js'

describe('isBlockedIp - IPv4', () => {
  const blocked = [
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',         // CGNAT / Tailscale
    'localhost',      // the dashboard host itself
    '100.127.255.255',
    '127.0.0.1',
    '127.0.0.2',          // missed by old literal-only check
    '127.255.255.255',
    '169.254.169.254',    // cloud metadata
    '169.254.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.0.0.1',
    '192.0.2.5',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.7',
    '224.0.0.1',          // multicast
    '255.255.255.255',
  ]
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isBlockedIp(ip)).toBe(true))
  }

  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '172.15.255.255',     // just below 172.16/12
    '172.32.0.1',         // just above 172.16/12
    '100.63.255.255',     // just below CGNAT
    '100.128.0.1',        // just above CGNAT
    '192.167.255.255',
    '193.168.0.1',
    '203.0.114.1',        // adjacent to TEST-NET-3 but public
    '198.20.0.1',
  ]
  for (const ip of allowed) {
    it(`allows ${ip}`, () => expect(isBlockedIp(ip)).toBe(false))
  }
})

describe('isBlockedIp - IPv6', () => {
  const blocked = [
    '::1',                          // loopback
    '::',                           // unspecified
    'fe80::1',                      // link-local
    'fe80::dead:beef',
    'fc00::1',                      // ULA
    'fd12:3456:789a::1',            // ULA
    'ff02::1',                      // multicast
    '::ffff:127.0.0.1',            // IPv4-mapped loopback
    '::ffff:10.0.0.1',             // IPv4-mapped private
    '::ffff:169.254.169.254',      // IPv4-mapped metadata
  ]
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isBlockedIp(ip)).toBe(true))
  }

  const allowed = [
    '2606:4700:4700::1111',        // Cloudflare
    '2001:4860:4860::8888',        // Google
    '::ffff:8.8.8.8',              // IPv4-mapped public
  ]
  for (const ip of allowed) {
    it(`allows ${ip}`, () => expect(isBlockedIp(ip)).toBe(false))
  }
})

describe('isBlockedIp - non-IP input', () => {
  for (const s of ['', 'not-an-ip', '999.1.1.1', 'example.com', '10.0.0']) {
    it(`treats "${s}" as unsafe`, () => expect(isBlockedIp(s)).toBe(true))
  }
})

describe('assertPublicUrl', () => {
  const rejected = [
    'http://127.0.0.1/hook',
    'http://127.0.0.2/hook',
    'http://localhost/hook',
    'http://app.localhost/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/hook',
    'http://[fd00::1]/hook',
    'http://[fe80::1]/hook',
    'http://localhost/hook',   // dashboard host via CGNAT
    'http://10.0.0.5/hook',
    'http://0.0.0.0/hook',
    'http://svc.internal/hook',
    'http://printer.local/hook',
    'ftp://example.com/hook',
    'file:///etc/passwd',
    'gopher://example.com/x',
    'not a url',
  ]
  for (const u of rejected) {
    it(`rejects ${u}`, () => expect(() => assertPublicUrl(u)).toThrow())
  }

  const accepted = [
    'http://example.com/hook',
    'https://hooks.slack.com/services/xxx',
    'http://8.8.8.8/hook',
    'https://discord.com/api/webhooks/1/abc',
  ]
  for (const u of accepted) {
    it(`accepts ${u}`, () => expect(assertPublicUrl(u).href).toContain(new URL(u).hostname))
  }
})

describe('safeFetch - synchronous reject paths (no socket opened)', () => {
  it('rejects a blocked literal IP', async () => {
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow()
  })
  it('rejects a disallowed scheme', async () => {
    await expect(safeFetch('ftp://example.com/x')).rejects.toThrow()
  })
  it('rejects loopback', async () => {
    await expect(safeFetch('http://127.0.0.1/x')).rejects.toThrow()
  })
})
