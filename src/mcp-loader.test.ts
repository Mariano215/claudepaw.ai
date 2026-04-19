import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import Database from 'better-sqlite3'

// Mock the credentials module so we can inject known plaintext
vi.mock('./credentials.js', () => ({
  getCredential: vi.fn(),
}))
import { getCredential } from './credentials.js'

// Mock db.ts getDb so the loader uses our test database
vi.mock('./db.js', () => ({
  getDb: vi.fn(),
}))
import { getDb } from './db.js'

import { loadProjectMcpServers } from './mcp-loader.js'

describe('mcp-loader', () => {
  let db: Database.Database
  let catalogDir: string

  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-'))
    db = new Database(path.join(dir, 'test.db'))
    db.exec(
      `CREATE TABLE projects (id TEXT PRIMARY KEY);
      INSERT INTO projects (id) VALUES ('p1');
      CREATE TABLE installed_integrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL, integration_id TEXT NOT NULL,
        status TEXT NOT NULL, account TEXT, last_verified_at INTEGER,
        last_error TEXT, installed_at INTEGER NOT NULL,
        UNIQUE(project_id, integration_id)
      );
      CREATE TABLE project_credentials (
        project_id TEXT NOT NULL, service TEXT NOT NULL, key TEXT NOT NULL,
        value BLOB NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        archived_at INTEGER,
        PRIMARY KEY (project_id, service, key)
      );`
    )
    catalogDir = path.join(dir, 'catalog')
    mkdirSync(catalogDir)
    vi.mocked(getDb).mockReturnValue(db)
    vi.mocked(getCredential).mockReset()
  })

  function writeManifest(id: string, content: any) {
    writeFileSync(path.join(catalogDir, `${id}.json`), JSON.stringify(content))
  }

  function insertInstalled(integration_id: string, status: string) {
    db.prepare(
      'INSERT INTO installed_integrations (project_id, integration_id, status, installed_at) VALUES (?, ?, ?, ?)'
    ).run('p1', integration_id, status, Date.now())
  }

  function insertCredentialRow(service: string, key: string, archived: boolean = false) {
    db.prepare(
      'INSERT INTO project_credentials (project_id, service, key, value, iv, tag, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('p1', service, key, Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0), 1, 1, archived ? Date.now() : null)
  }

  it('returns empty array when no MCP integrations installed', async () => {
    const result = await loadProjectMcpServers('p1', catalogDir)
    expect(result).toEqual([])
  })

  it('builds MCP server config from a connected installation with no creds', async () => {
    writeManifest('mem', {
      id: 'mem', name: 'Memory', category: 'other', icon: 'database',
      description: 'd', kind: 'mcp_server',
      mcp: { command: 'npx', args: ['-y', 'mem'], env_from_credentials: [], transport: 'stdio' },
      setup: { credentials_required: [] },
      verify: { kind: 'mcp_tool_call', tool: 't', args: {}, timeout_ms: 1000 },
    })
    insertInstalled('mem', 'connected')
    const result = await loadProjectMcpServers('p1', catalogDir)
    expect(result).toHaveLength(1)
    expect(result[0]!.command).toBe('npx')
    expect(result[0]!.args).toEqual(['-y', 'mem'])
  })

  it('skips integrations that are not connected', async () => {
    writeManifest('mem', {
      id: 'mem', name: 'Memory', category: 'other', icon: 'database',
      description: 'd', kind: 'mcp_server',
      mcp: { command: 'npx', args: [], env_from_credentials: [], transport: 'stdio' },
      setup: { credentials_required: [] },
      verify: { kind: 'mcp_tool_call', tool: 't', args: {}, timeout_ms: 1000 },
    })
    insertInstalled('mem', 'error')
    const result = await loadProjectMcpServers('p1', catalogDir)
    expect(result).toEqual([])
  })

  it('injects credentials as env vars', async () => {
    writeManifest('stripe-mcp', {
      id: 'stripe-mcp', name: 'Stripe MCP', category: 'payments', icon: 'credit-card',
      description: 'd', kind: 'mcp_server',
      mcp: { command: 'npx', args: [], env_from_credentials: ['stripe.api_key'], transport: 'stdio' },
      setup: { credentials_required: [{ service: 'stripe', key: 'api_key', label: 'k', input_type: 'password' }] },
      verify: { kind: 'mcp_tool_call', tool: 't', args: {}, timeout_ms: 1000 },
    })
    insertInstalled('stripe-mcp', 'connected')
    insertCredentialRow('stripe', 'api_key')
    vi.mocked(getCredential).mockImplementation((_p: string, service: string, key: string) => {
      if (service === 'stripe' && key === 'api_key') return 'sk_test_123'
      return null
    })
    const result = await loadProjectMcpServers('p1', catalogDir)
    expect(result[0]!.env).toBeDefined()
    expect(result[0]!.env!.STRIPE_API_KEY).toBe('sk_test_123')
  })

  it('skips integrations whose credentials are archived', async () => {
    writeManifest('stripe-mcp', {
      id: 'stripe-mcp', name: 'Stripe MCP', category: 'payments', icon: 'credit-card',
      description: 'd', kind: 'mcp_server',
      mcp: { command: 'npx', args: [], env_from_credentials: ['stripe.api_key'], transport: 'stdio' },
      setup: { credentials_required: [{ service: 'stripe', key: 'api_key', label: 'k', input_type: 'password' }] },
      verify: { kind: 'mcp_tool_call', tool: 't', args: {}, timeout_ms: 1000 },
    })
    insertInstalled('stripe-mcp', 'connected')
    insertCredentialRow('stripe', 'api_key', true /* archived */)
    const result = await loadProjectMcpServers('p1', catalogDir)
    expect(result).toEqual([])
  })

  it('skips integrations with missing credentials instead of throwing', async () => {
    writeManifest('stripe-mcp', {
      id: 'stripe-mcp', name: 'Stripe MCP', category: 'payments', icon: 'credit-card',
      description: 'd', kind: 'mcp_server',
      mcp: { command: 'npx', args: [], env_from_credentials: ['stripe.api_key'], transport: 'stdio' },
      setup: { credentials_required: [{ service: 'stripe', key: 'api_key', label: 'k', input_type: 'password' }] },
      verify: { kind: 'mcp_tool_call', tool: 't', args: {}, timeout_ms: 1000 },
    })
    insertInstalled('stripe-mcp', 'connected')
    // No credential row inserted
    const result = await loadProjectMcpServers('p1', catalogDir)
    expect(result).toEqual([])
  })
})
