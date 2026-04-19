import { readdirSync, readFileSync, existsSync } from 'fs'
import path from 'path'
import { logger } from './logger.js'
import { getDb } from './db.js'
import { getCredential } from './credentials.js'

export type McpServerConfig = {
  command: string
  args: string[]
  env?: Record<string, string>
}

type McpManifest = {
  id: string
  kind: 'mcp_server'
  mcp: {
    command: string
    args: string[]
    env_from_credentials: string[]
    transport: 'stdio'
  }
}

const DEFAULT_CATALOG_DIR = path.join(process.cwd(), 'server', 'integrations', 'catalog')

// Only allow known-safe executables as MCP server commands
const ALLOWED_MCP_COMMANDS = new Set(['npx', 'node', 'uvx', 'python3', 'python'])

function isValidMcpManifest(parsed: unknown): parsed is McpManifest {
  if (!parsed || typeof parsed !== 'object') return false
  const p = parsed as Record<string, unknown>
  if (typeof p['id'] !== 'string' || !p['id']) return false
  if (p['kind'] !== 'mcp_server') return false
  const mcp = p['mcp']
  if (!mcp || typeof mcp !== 'object') return false
  const m = mcp as Record<string, unknown>
  if (typeof m['command'] !== 'string' || !ALLOWED_MCP_COMMANDS.has(m['command'])) return false
  if (!Array.isArray(m['args']) || !m['args'].every((a: unknown) => typeof a === 'string')) return false
  if (!Array.isArray(m['env_from_credentials'])) return false
  return true
}

function loadMcpManifests(catalogDir: string): Map<string, McpManifest> {
  const out = new Map<string, McpManifest>()
  if (!existsSync(catalogDir)) return out
  let files: string[]
  try { files = readdirSync(catalogDir).filter(f => f.endsWith('.json')) } catch { return out }
  for (const file of files) {
    try {
      const raw = readFileSync(path.join(catalogDir, file), 'utf8')
      const parsed = JSON.parse(raw)
      if (isValidMcpManifest(parsed)) {
        out.set(parsed.id, parsed)
      } else if (parsed?.kind === 'mcp_server') {
        logger.warn({ file }, 'mcp-loader: skipping manifest with invalid structure or disallowed command')
      }
    } catch { /* skip bad JSON */ }
  }
  return out
}

function buildEnv(envRefs: string[], creds: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const ref of envRefs) {
    const envName = ref.toUpperCase().replace(/[.-]/g, '_')
    if (creds[ref] !== undefined) env[envName] = creds[ref]
  }
  return env
}

export async function loadProjectMcpServers(
  projectId: string,
  catalogDir = DEFAULT_CATALOG_DIR,
): Promise<McpServerConfig[]> {
  const out: McpServerConfig[] = []
  let db
  try { db = getDb() } catch (err) {
    logger.warn({ err }, 'mcp-loader: db unavailable')
    return out
  }

  const installed = db.prepare(
    `SELECT integration_id FROM installed_integrations
     WHERE project_id = ? AND status = 'connected'`
  ).all(projectId) as Array<{ integration_id: string }>

  if (installed.length === 0) return out

  const manifests = loadMcpManifests(catalogDir)

  for (const row of installed) {
    const manifest = manifests.get(row.integration_id)
    if (!manifest) continue // Not an MCP integration

    const creds: Record<string, string> = {}
    let skip = false
    for (const ref of manifest.mcp.env_from_credentials) {
      const dotIdx = ref.indexOf('.')
      if (dotIdx === -1) { skip = true; break }
      const service = ref.slice(0, dotIdx)
      const key = ref.slice(dotIdx + 1)

      // Check for archived credential
      const credRow = db.prepare(
        `SELECT archived_at FROM project_credentials
         WHERE project_id = ? AND service = ? AND key = ?`
      ).get(projectId, service, key) as { archived_at: number | null } | undefined
      if (!credRow || credRow.archived_at !== null) { skip = true; break }

      try {
        const plaintext = getCredential(projectId, service, key)
        if (plaintext === null) { skip = true; break }
        creds[ref] = plaintext
      } catch (err) {
        logger.warn({ err, service, key }, 'mcp-loader: credential decrypt failed')
        skip = true
        break
      }
    }
    if (skip) {
      logger.warn({ integrationId: row.integration_id, projectId }, 'mcp-loader: skipping integration with missing/archived credentials')
      continue
    }

    out.push({
      command: manifest.mcp.command,
      args: manifest.mcp.args,
      env: buildEnv(manifest.mcp.env_from_credentials, creds),
    })
  }

  return out
}
