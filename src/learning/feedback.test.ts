import { describe, it, expect } from 'vitest'
import { isCorrection, CORRECTION_PATTERNS } from './feedback.js'

describe('isCorrection', () => {
  it('detects "no, I meant" as a correction', () => {
    expect(isCorrection('no, I meant the other project')).toBe(true)
  })

  it('detects "that\'s wrong" as a correction', () => {
    expect(isCorrection("that's wrong, it should be ExampleApp")).toBe(true)
  })

  it('detects "not what I asked" as a correction', () => {
    expect(isCorrection('not what I asked for')).toBe(true)
  })

  it('detects "try again" as a correction', () => {
    expect(isCorrection('try again but with more detail')).toBe(true)
  })

  it('detects "actually" at the start as a correction', () => {
    expect(isCorrection('actually I wanted a different approach')).toBe(true)
  })

  it('does not flag normal messages', () => {
    expect(isCorrection('what is the status of ExampleApp?')).toBe(false)
  })

  it('does not flag "no" in the middle of a sentence', () => {
    expect(isCorrection('there is no way to do that')).toBe(false)
  })

  it('does not flag "actually" mid-sentence', () => {
    expect(isCorrection('the server is actually running fine')).toBe(false)
  })
})

describe('CORRECTION_PATTERNS', () => {
  it('is a non-empty array of RegExp', () => {
    expect(CORRECTION_PATTERNS.length).toBeGreaterThan(0)
    for (const p of CORRECTION_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp)
    }
  })
})
