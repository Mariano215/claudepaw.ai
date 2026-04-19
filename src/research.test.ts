import { describe, it, expect } from 'vitest'
import { extractFindings, slugify, generateFindingId } from './research.js'

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(slugify('OpenClaw Added MCP Support')).toBe('openclaw-added-mcp-support')
  })

  it('collapses multiple hyphens', () => {
    expect(slugify('foo---bar!!!baz')).toBe('foo-bar-baz')
  })

  it('trims leading/trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello')
  })

  it('truncates to 80 chars', () => {
    const long = 'a'.repeat(100)
    expect(slugify(long).length).toBeLessThanOrEqual(80)
  })

  it('handles empty string', () => {
    expect(slugify('')).toBe('')
  })
})

describe('generateFindingId', () => {
  it('combines slug with date', () => {
    const id = generateFindingId('OpenClaw ships MCP')
    expect(id).toMatch(/^openclaw-ships-mcp-\d{4}-\d{2}-\d{2}$/)
  })
})

describe('extractFindings', () => {
  it('extracts a single finding', () => {
    const output = `Some text before
<!-- FINDING: {"topic":"OpenClaw added MCP support","source":"GitHub","category":"ai","score":75} -->
Some text after`

    const findings = extractFindings(output)
    expect(findings).toHaveLength(1)
    expect(findings[0].topic).toBe('OpenClaw added MCP support')
    expect(findings[0].source).toBe('GitHub')
    expect(findings[0].category).toBe('ai')
    expect(findings[0].score).toBe(75)
  })

  it('extracts multiple findings', () => {
    const output = `
<!-- FINDING: {"topic":"Finding one","category":"cyber"} -->
Some text in between
<!-- FINDING: {"topic":"Finding two","category":"ai"} -->
`
    const findings = extractFindings(output)
    expect(findings).toHaveLength(2)
    expect(findings[0].topic).toBe('Finding one')
    expect(findings[1].topic).toBe('Finding two')
  })

  it('skips findings without topic', () => {
    const output = '<!-- FINDING: {"source":"GitHub","score":50} -->'
    const findings = extractFindings(output)
    expect(findings).toHaveLength(0)
  })

  it('skips malformed JSON', () => {
    const output = '<!-- FINDING: {not valid json} -->'
    const findings = extractFindings(output)
    expect(findings).toHaveLength(0)
  })

  it('returns empty array when no findings', () => {
    const output = 'Just a normal agent response with no findings.'
    const findings = extractFindings(output)
    expect(findings).toHaveLength(0)
  })

  it('handles extra whitespace in markers', () => {
    const output = '<!--  FINDING:  {"topic":"Whitespace test"}  -->'
    const findings = extractFindings(output)
    expect(findings).toHaveLength(1)
    expect(findings[0].topic).toBe('Whitespace test')
  })

  it('applies default values for optional fields', () => {
    const output = '<!-- FINDING: {"topic":"Minimal finding"} -->'
    const findings = extractFindings(output)
    expect(findings).toHaveLength(1)
    expect(findings[0].category).toBe('general')
    expect(findings[0].score).toBe(50)
    expect(findings[0].status).toBe('new')
    expect(findings[0].pipeline).toBe('idea')
  })

  it('returns empty on null/empty input', () => {
    expect(extractFindings(null as unknown as string)).toHaveLength(0)
    expect(extractFindings('')).toHaveLength(0)
  })
})
