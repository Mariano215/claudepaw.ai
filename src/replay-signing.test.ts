import { describe, it, expect, vi } from 'vitest'

vi.mock('./config.js', () => ({
  CREDENTIAL_ENCRYPTION_KEY: 'x'.repeat(32),
  WS_SECRET: '',
}))

import { signReplay, verifyReplaySignature, canSignReplay } from './replay-signing.js'

const ARGV = ['dist/social-cli.js', 'publish', 'p1']
const CWD = '/repo'

describe('replay signing', () => {
  it('verifies a signature it just minted', () => {
    const sig = signReplay('c1', ARGV, CWD)!
    expect(sig).toMatch(/^[0-9a-f]{64}$/)
    expect(verifyReplaySignature('c1', { argv: ARGV, cwd: CWD, sig })).toBe(true)
  })

  it('rejects a changed argv, which is the whole point', () => {
    const sig = signReplay('c1', ARGV, CWD)!
    expect(verifyReplaySignature('c1', { argv: ['dist/social-cli.js', 'publish', 'p2'], cwd: CWD, sig })).toBe(false)
    expect(verifyReplaySignature('c1', { argv: ['dist/schedule-cli.js', 'delete', 'x'], cwd: CWD, sig })).toBe(false)
  })

  it('rejects a changed cwd and a signature lifted from another card', () => {
    const sig = signReplay('c1', ARGV, CWD)!
    expect(verifyReplaySignature('c1', { argv: ARGV, cwd: '/elsewhere', sig })).toBe(false)
    expect(verifyReplaySignature('c2', { argv: ARGV, cwd: CWD, sig })).toBe(false)
  })

  it('rejects a missing or malformed signature without throwing', () => {
    expect(verifyReplaySignature('c1', { argv: ARGV, cwd: CWD })).toBe(false)
    expect(verifyReplaySignature('c1', { argv: ARGV, cwd: CWD, sig: '' })).toBe(false)
    expect(verifyReplaySignature('c1', { argv: ARGV, cwd: CWD, sig: 'not-hex' })).toBe(false)
    expect(verifyReplaySignature('c1', { argv: ARGV, cwd: CWD, sig: 'ab'.repeat(40) })).toBe(false)
  })

  it('reports that it can sign when a secret is configured', () => {
    expect(canSignReplay()).toBe(true)
  })
})
