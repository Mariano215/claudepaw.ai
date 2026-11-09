import { describe, it, expect } from 'vitest'
import { verifyMcpServerIntegration, buildMcpEnv } from './mcp_server.js'
import type { IntegrationManifest } from '../schema.js'

const baseMcpManifest: IntegrationManifest = {
  id: 'mem', name: 'Memory', category: 'other', icon: 'database',
  description: 'reference memory MCP server',
  kind: 'mcp_server',
  mcp: {
    command: '/nonexistent/binary',
    args: [],
    env_from_credentials: [],
    transport: 'stdio',
  },
  setup: { credentials_required: [] },
  verify: { kind: 'mcp_tool_call', tool: 'ping', args: {}, timeout_ms: 3000 },
}

describe('buildMcpEnv', () => {
  it('uppercases credential refs and substitutes dots with underscores', () => {
    const env = buildMcpEnv(['stripe.api_key'], { 'stripe.api_key': 'sk_x' })
    expect(env.STRIPE_API_KEY).toBe('sk_x')
  })

  it('skips references not present in creds', () => {
    const env = buildMcpEnv(['github.token', 'missing.key'], { 'github.token': 'gh_abc' })
    expect(env.GITHUB_TOKEN).toBe('gh_abc')
    expect(env.MISSING_KEY).toBeUndefined()
  })

  it('returns empty env when no references', () => {
    expect(buildMcpEnv([], {})).toEqual({})
  })
})

// Build an inline mock MCP server script with the behavior baked in as literal code.
// Each call produces a unique script so no env vars or argv tricks are needed.
function makeMockScript(behavior: string): string {
  const toolCallResponse = behavior === 'no_tool_reply'
    ? '/* no reply */'
    : behavior === 'tool_error'
      ? `process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }) + '\\n')`
      : `process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [] } }) + '\\n')`

  if (behavior === 'exit_zero') return `process.exit(0)`

  return `
const readline = require('readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  try {
    const msg = JSON.parse(line)
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {} } }) + '\\n')
    } else if (msg.method === 'tools/call') {
      ${toolCallResponse}
    }
  } catch {}
})
`
}

function makeMcpManifest(behavior: string, timeoutMs = 3000): IntegrationManifest {
  return {
    ...baseMcpManifest,
    mcp: { command: 'node', args: ['-e', makeMockScript(behavior)], env_from_credentials: [], transport: 'stdio' },
    verify: { kind: 'mcp_tool_call', tool: 'ping', args: {}, timeout_ms: timeoutMs },
  }
}

describe('verifyMcpServerIntegration', () => {
  it('returns error for a command that does not exist', async () => {
    const r = await verifyMcpServerIntegration(baseMcpManifest, {})
    expect(r.status).toBe('error')
    expect(r.error).toBeTruthy()
    expect(r.error).toContain('/nonexistent/binary')
  }, 10000)

  it('returns error for wrong manifest kind', async () => {
    const bad = { ...baseMcpManifest, kind: 'api_key' } as any
    const r = await verifyMcpServerIntegration(bad, {})
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/not an mcp_server/)
  })

  it('returns connected after a successful JSON-RPC handshake', async () => {
    const r = await verifyMcpServerIntegration(makeMcpManifest('success'), {})
    expect(r.status).toBe('connected')
    expect(r.error).toBeUndefined()
  }, 10000)

  it('returns error when tool call responds with msg.error', async () => {
    const r = await verifyMcpServerIntegration(makeMcpManifest('tool_error'), {})
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/tool call failed/)
    expect(r.error).toContain('method not found')
  }, 10000)

  it('returns error with timeout message when server never replies to tool call', async () => {
    const r = await verifyMcpServerIntegration(makeMcpManifest('no_tool_reply', 500), {})
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/500ms/)
  }, 5000)

  it('returns error when server exits with code 0 before verify completes', async () => {
    const r = await verifyMcpServerIntegration(makeMcpManifest('exit_zero'), {})
    expect(r.status).toBe('error')
    expect(r.error).toMatch(/exited.*before verify/)
  }, 5000)
})
