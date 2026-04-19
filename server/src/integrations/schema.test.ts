import { describe, it, expect } from 'vitest'
import { manifestSchema } from './schema.js'

describe('manifestSchema', () => {
  it('accepts a valid oauth manifest', () => {
    const m = {
      id: 'google',
      name: 'Google',
      category: 'communication',
      icon: 'mail',
      description: 'Google account access',
      kind: 'oauth',
      oauth: { provider: 'google', scopes: ['email'] },
      setup: { credentials_required: [] },
      verify: { kind: 'oauth_profile', endpoint: 'https://example.com', account_field: 'email' },
    }
    expect(manifestSchema.safeParse(m).success).toBe(true)
  })

  it('accepts a valid api_key manifest', () => {
    const m = {
      id: 'stripe',
      name: 'Stripe',
      category: 'payments',
      icon: 'credit-card',
      description: 'Stripe API access',
      kind: 'api_key',
      api_key: {
        credential_key: 'stripe.api_key',
        test_endpoint: 'https://api.stripe.com/v1/charges',
        test_header: 'Authorization: Bearer {api_key}',
      },
      setup: {
        credentials_required: [
          { service: 'stripe', key: 'api_key', label: 'Secret Key', input_type: 'password' },
        ],
      },
      verify: {
        kind: 'http_get',
        endpoint: 'https://api.stripe.com/v1/charges?limit=1',
        header_template: 'Authorization: Bearer {api_key}',
        expect_status: 200,
      },
    }
    expect(manifestSchema.safeParse(m).success).toBe(true)
  })

  it('accepts a valid mcp_server manifest', () => {
    const m = {
      id: 'github-mcp',
      name: 'GitHub (MCP)',
      category: 'dev-tools',
      icon: 'github',
      description: 'GitHub via MCP',
      kind: 'mcp_server',
      mcp: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github@1.0.0'],
        env_from_credentials: ['github.token'],
        transport: 'stdio',
      },
      setup: { credentials_required: [{ service: 'github', key: 'token', label: 'Token', input_type: 'password' }] },
      verify: { kind: 'mcp_tool_call', tool: 'list_repos', args: {}, timeout_ms: 10000 },
    }
    expect(manifestSchema.safeParse(m).success).toBe(true)
  })

  it('rejects manifest with kind=mcp_server but no mcp block', () => {
    const m = {
      id: 'broken', name: 'Broken', category: 'other', icon: 'x', description: 'd',
      kind: 'mcp_server',
      setup: { credentials_required: [] },
      verify: { kind: 'mcp_tool_call', tool: 't', args: {}, timeout_ms: 1000 },
    }
    expect(manifestSchema.safeParse(m).success).toBe(false)
  })

  it('rejects manifest with missing required top-level fields', () => {
    expect(manifestSchema.safeParse({ id: 'x' }).success).toBe(false)
  })
})
