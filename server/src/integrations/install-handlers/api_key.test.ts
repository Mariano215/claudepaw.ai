import { describe, it, expect, vi, beforeEach } from 'vitest'
import { verifyApiKeyIntegration } from './api_key.js'
import type { IntegrationManifest } from '../schema.js'

const baseManifest: IntegrationManifest = {
  id: 'demo', name: 'Demo', category: 'other', icon: 'x', description: 'd',
  kind: 'api_key',
  api_key: { credential_key: 'demo.api_key', test_endpoint: 'https://api.example.com/me', test_header: 'Authorization: Bearer {api_key}' },
  setup: { credentials_required: [{ service: 'demo', key: 'api_key', label: 'Key', input_type: 'password' }] },
  verify: { kind: 'http_get', endpoint: 'https://api.example.com/me', header_template: 'Authorization: Bearer {api_key}', expect_status: 200, account_field: 'email' },
}

describe('verifyApiKeyIntegration', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('returns connected on a 200 response with extracted account', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ email: 'a@b.com' }), { status: 200 }))
    const r = await verifyApiKeyIntegration(baseManifest, { api_key: 'sk_xxx' })
    expect(r.status).toBe('connected')
    expect(r.account).toBe('a@b.com')
    expect(r.error).toBeUndefined()
  })

  it('returns error on a 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const r = await verifyApiKeyIntegration(baseManifest, { api_key: 'bad_key' })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/expected 200, got 401/)
  })

  it('returns error on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENETUNREACH'))
    const r = await verifyApiKeyIntegration(baseManifest, { api_key: 'sk_key_1' })
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/ENETUNREACH/)
  })

  it('does not echo credential value in error message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unauthorized: token sk_secret_value invalid', { status: 401 }))
    const r = await verifyApiKeyIntegration(baseManifest, { api_key: 'sk_secret_value' })
    expect(r.error).not.toContain('sk_secret_value')
    expect(r.error).toContain('[REDACTED]')
  })

  it('returns error if credential missing for header substitution', async () => {
    const r = await verifyApiKeyIntegration(baseManifest, {})
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/missing credential/)
  })
})
