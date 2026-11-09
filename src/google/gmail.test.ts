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

  it('builds multipart/related when inline images are present', () => {
    const raw = buildRawMessage({
      to: '',
      subject: 'Property Scout test',
      htmlBody: '<p><img src="cid:map-0"></p>',
      inlineImages: [
        {
          cid: 'map-0',
          contentType: 'image/png',
          data: Buffer.from('fake-png-bytes'),
        },
      ],
    })
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8')
    expect(decoded).toContain('Content-Type: multipart/related;')
    expect(decoded).toContain('Content-ID: <map-0>')
    expect(decoded).toContain('Content-Transfer-Encoding: base64')
    expect(decoded).toContain('src="cid:map-0"')
    const boundaryMatch = decoded.match(/boundary="([^"]+)"/)
    expect(boundaryMatch).not.toBeNull()
    const boundary = boundaryMatch![1]
    expect(decoded).toContain(`--${boundary}`)
    expect(decoded).toContain(`--${boundary}--`)
    expect(decoded).toContain(Buffer.from('fake-png-bytes').toString('base64'))
  })

  it('falls back to simple HTML when inlineImages is empty', () => {
    const raw = buildRawMessage({
      to: 'test@example.com',
      subject: 'Plain',
      htmlBody: '<p>hello</p>',
      inlineImages: [],
    })
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8')
    expect(decoded).toContain('Content-Type: text/html; charset=utf-8')
    expect(decoded).not.toContain('multipart/related')
  })
})
