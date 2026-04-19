// src/guard/layers/l1-sanitize.test.ts
import { describe, it, expect } from 'vitest'
import { sanitize } from './l1-sanitize.js'

describe('l1-sanitize', () => {
  it('strips zero-width characters', () => {
    const input = 'Hello\u200BWorld\u200C\u200D\u200E\u200F'
    const result = sanitize(input)
    expect(result.cleanedText).toBe('Hello World')
    expect(result.charsRemoved).toBeGreaterThan(0)
  })

  it('strips Unicode directional overrides', () => {
    const input = 'normal\u202Atext\u202B\u202C\u202D\u202E'
    const result = sanitize(input)
    expect(result.cleanedText).toBe('normal text')
  })

  it('strips FEFF BOM and word joiner', () => {
    const input = '\uFEFFHello\u2060World'
    const result = sanitize(input)
    expect(result.cleanedText).toBe('Hello World')
  })

  it('strips line/paragraph separators', () => {
    const input = 'line\u2028break\u2029end'
    const result = sanitize(input)
    expect(result.cleanedText).toBe('line break end')
  })

  it('collapses whitespace runs', () => {
    const input = 'hello    world   test'
    const result = sanitize(input)
    expect(result.cleanedText).toBe('hello world test')
  })

  it('trims leading and trailing whitespace', () => {
    const input = '   hello world   '
    const result = sanitize(input)
    expect(result.cleanedText).toBe('hello world')
  })

  it('truncates at word boundary when exceeding maxChars', () => {
    const input = 'word '.repeat(1000) // 5000 chars
    const result = sanitize(input, 100)
    expect(result.cleanedText.length).toBeLessThanOrEqual(100)
    expect(result.wasTruncated).toBe(true)
    // Should not end mid-word
    expect(result.cleanedText).not.toMatch(/\S$\s/)
  })

  it('does not truncate short messages', () => {
    const input = 'short message'
    const result = sanitize(input)
    expect(result.wasTruncated).toBe(false)
    expect(result.cleanedText).toBe('short message')
  })

  it('returns correct charsRemoved count', () => {
    const input = 'ab\u200Bcd'
    const result = sanitize(input)
    expect(result.cleanedText).toBe('ab cd')
    expect(result.charsRemoved).toBe(1) // one zero-width removed
  })

  it('handles empty string', () => {
    const result = sanitize('')
    expect(result.cleanedText).toBe('')
    expect(result.charsRemoved).toBe(0)
    expect(result.wasTruncated).toBe(false)
  })

  it('returns L1Result shape', () => {
    const result = sanitize('test')
    expect(result.layer).toBe('l1-sanitize')
  })
})
