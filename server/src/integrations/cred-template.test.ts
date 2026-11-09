import { describe, it, expect } from 'vitest'
import { fillTemplate, redactTemplate, parseHeaderTemplate } from './cred-template.js'

describe('cred-template', () => {
  it('substitutes a single placeholder', () => {
    expect(fillTemplate('Bearer {api_key}', { api_key: 'sk_test_123' })).toBe('Bearer sk_test_123')
  })

  it('substitutes multiple placeholders', () => {
    expect(fillTemplate('{u}:{p}', { u: 'alice', p: 'pw' })).toBe('alice:pw')
  })

  it('throws when placeholder is missing from creds', () => {
    expect(() => fillTemplate('Bearer {api_key}', {})).toThrow(/missing credential: api_key/)
  })

  it('redactTemplate returns the template unchanged (for error display)', () => {
    expect(redactTemplate('Bearer {api_key}')).toBe('Bearer {api_key}')
  })

  it('parseHeaderTemplate splits a filled header into name and value', () => {
    const parsed = parseHeaderTemplate('Authorization: Bearer sk_test_123')
    expect(parsed).toEqual({ name: 'Authorization', value: 'Bearer sk_test_123' })
  })

  it('parseHeaderTemplate throws on a string with no colon', () => {
    expect(() => parseHeaderTemplate('NoColonHere')).toThrow(/invalid header template/)
  })
})
