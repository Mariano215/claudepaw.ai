// The version comparison and the evidence parsing are the parts that can be
// wrong in a way nobody notices, so they are pinned here. The update itself is
// a shell call and is not exercised.
import { describe, it, expect } from 'vitest'
import { parseSemver, compareSemver, highestRequiredVersion } from '../cli-version-guard.js'

// The exact error text the API returned on 2026-09-07, which is what the rule
// has to read. 23 cycles failed carrying this string.
const REAL_ERROR =
  'ANALYZE phase failed: Claude Code returned an error result: API Error: 400 ' +
  'Claude Code 2.1.141 does not support this model; version 2.1.251 or newer is ' +
  "required. Run 'claude update', or update the Claude Code CLI."

describe('parseSemver', () => {
  it('reads a bare version', () => {
    expect(parseSemver('2.1.267')).toEqual([2, 1, 267])
  })

  it('reads the version out of real --version output', () => {
    expect(parseSemver('2.1.267 (Claude Code)')).toEqual([2, 1, 267])
  })

  it('returns null when there is no version', () => {
    expect(parseSemver('unknown')).toBeNull()
  })
})

describe('compareSemver', () => {
  it('orders by patch', () => {
    expect(compareSemver([2, 1, 141], [2, 1, 251])).toBeLessThan(0)
    expect(compareSemver([2, 1, 267], [2, 1, 251])).toBeGreaterThan(0)
  })

  it('treats equal versions as met', () => {
    expect(compareSemver([2, 1, 251], [2, 1, 251])).toBe(0)
  })

  // A naive string compare puts "2.1.9" above "2.1.141", which would hide a
  // real shortfall.
  it('compares numerically, not as strings', () => {
    expect(compareSemver([2, 1, 9], [2, 1, 141])).toBeLessThan(0)
  })

  it('orders by minor and major before patch', () => {
    expect(compareSemver([2, 0, 999], [2, 1, 0])).toBeLessThan(0)
    expect(compareSemver([1, 9, 9], [2, 0, 0])).toBeLessThan(0)
  })
})

describe('highestRequiredVersion', () => {
  it('reads the floor out of the real error text', () => {
    expect(highestRequiredVersion([REAL_ERROR])).toEqual([2, 1, 251])
  })

  it('takes the highest requirement, not the most recent', () => {
    const older = REAL_ERROR.replace('2.1.251 or newer', '2.1.200 or newer')
    expect(highestRequiredVersion([older, REAL_ERROR])).toEqual([2, 1, 251])
    // Reversed order must give the same answer: a stale error naming an older
    // floor cannot walk the requirement backwards.
    expect(highestRequiredVersion([REAL_ERROR, older])).toEqual([2, 1, 251])
  })

  it('ignores unrelated errors so the rule stays a no-op', () => {
    expect(highestRequiredVersion([
      null,
      'ANALYZE phase failed: fetch failed',
      'approval timeout',
    ])).toBeNull()
  })

  it('does not mistake the version it saw for the version it wants', () => {
    // 2.1.141 appears first in the string. Matching it would be a silent
    // off-by-one that never updates anything.
    expect(highestRequiredVersion([REAL_ERROR])).not.toEqual([2, 1, 141])
  })
})
