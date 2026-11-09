import { describe, it, expect } from 'vitest'
import { parseCopyResponse, buildCopyPrompt } from './copywriter.js'

describe('buildCopyPrompt', () => {
  it('includes title, URL, description, and type', () => {
    const prompt = buildCopyPrompt({
      id: 'abc12345678',
      title: 'How I Built X',
      description: 'This is a 500-char description. '.repeat(20),
      isShort: false,
      publishedAt: '2026-04-20T00:00:00Z',
    })
    expect(prompt).toContain('How I Built X')
    expect(prompt).toContain('https://youtu.be/abc12345678')
    expect(prompt).toContain('video')
    expect(prompt.length).toBeLessThan(4000)
  })

  it('marks shorts as short', () => {
    const prompt = buildCopyPrompt({
      id: 'xyz98765432',
      title: 'Short one',
      description: '',
      isShort: true,
      publishedAt: '2026-04-20T00:00:00Z',
    })
    expect(prompt).toContain('short')
  })
})

describe('parseCopyResponse', () => {
  it('parses a valid JSON object with linkedin + twitter keys', () => {
    const raw = '```json\n{\n  "linkedin": "LI text",\n  "twitter": "X text"\n}\n```'
    const out = parseCopyResponse(raw)
    expect(out).toEqual({ linkedin: 'LI text', twitter: 'X text' })
  })

  it('parses raw JSON without fences', () => {
    const raw = '{"linkedin":"a","twitter":"b"}'
    expect(parseCopyResponse(raw)).toEqual({ linkedin: 'a', twitter: 'b' })
  })

  it('throws on malformed JSON', () => {
    expect(() => parseCopyResponse('not json at all')).toThrow()
  })

  it('throws when keys are missing', () => {
    expect(() => parseCopyResponse('{"linkedin":"a"}')).toThrow(/twitter/)
  })
})
