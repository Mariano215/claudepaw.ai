import { describe, it, expect } from 'vitest'
import { buildRawMessage } from './gmail.js'

describe('buildRawMessage', () => {
  it('builds a valid RFC 2822 message', () => {
    const raw = buildRawMessage({
      to: 'test@example.com',
      subject: 'Test Subject',
      htmlBody: '<h1>Hello</h1>',
    })
    expect(typeof raw).toBe('string')
    // Base64url encoded (no + or /)
    expect(raw).not.toContain('+')
    expect(raw).not.toContain('/')
    // Decode and check headers
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8')
    expect(decoded).toContain('To: test@example.com')
    expect(decoded).toContain('Subject: Test Subject')
    expect(decoded).toContain('Content-Type: text/html; charset=utf-8')
    expect(decoded).toContain('<h1>Hello</h1>')
  })

  it('handles special characters in subject', () => {
    const raw = buildRawMessage({
      to: 'test@example.com',
      subject: 'AI & Cybersecurity Brief',
      htmlBody: '<p>Content</p>',
    })
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8')
    expect(decoded).toContain('AI & Cybersecurity Brief')
  })
})
