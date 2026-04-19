import { Router, type Request, type Response } from 'express'
import path from 'path'
import { requireProjectRole } from '../auth.js'
import { getAllCatalogEntries, getCatalogEntry, loadCatalog } from './loader.js'
import {
  listInstalledForProject,
  upsertInstalledIntegration,
  setInstalledStatus,
  getInstalledIntegration,
  deleteInstalledIntegration,
  installedStoreInit,
} from './installed-store.js'
import { verifyApiKeyIntegration } from './install-handlers/api_key.js'
import { verifyMcpServerIntegration } from './install-handlers/mcp_server.js'
import { listConnectedOAuthAccounts, buildOAuthAuthUrl } from './install-handlers/oauth.js'
import { setOAuthCredential, getBotDbWrite, credDecryptForVerify, listOAuthServices, getOAuthServiceCredentials } from '../db.js'

async function decryptProjectCreds(
  projectId: string,
  fields: Array<{ service: string; key: string }>,
): Promise<{ creds?: Record<string, string>; error?: { code: string; key?: string } }> {
  const bdb = getBotDbWrite()
  if (!bdb) return { error: { code: 'db_unavailable' } }
  const creds: Record<string, string> = {}
  for (const f of fields) {
    const row = bdb.prepare(
      'SELECT value, iv, tag FROM project_credentials WHERE project_id = ? AND service = ? AND key = ? AND archived_at IS NULL'
    ).get(projectId, f.service, f.key) as { value: Buffer; iv: Buffer; tag: Buffer } | undefined
    if (!row) return { error: { code: 'credential_missing', key: f.key } }
    try {
      creds[`${f.service}.${f.key}`] = credDecryptForVerify(row.value, row.iv, row.tag)
    } catch {
      return { error: { code: 'credential_decrypt_failed', key: f.key } }
    }
  }
  return { creds }
}

/**
 * Seed installed_integrations rows from pre-existing OAuth connections.
 * Runs once at startup so the Connected tab reflects what's already wired up.
 */
function migrateExistingOAuthConnections(): void {
  const bdb = getBotDbWrite()
  if (!bdb) return
  // Get all projects that have OAuth services
  const projects = bdb.prepare(
    'SELECT DISTINCT project_id FROM project_credentials WHERE service LIKE ?'
  ).all('google:%') as Array<{ project_id: string }>

  for (const { project_id } of projects) {
    // Check if Google OAuth is connected for this project
    const services = listOAuthServices(project_id)
    for (const svc of services) {
      if (!svc.startsWith('google:')) continue
      const account = svc.slice('google:'.length)
      const creds = getOAuthServiceCredentials(project_id, svc)
      if (creds.status !== 'connected') continue

      // Only seed if not already in installed_integrations
      const existing = getInstalledIntegration(project_id, 'google')
      if (existing) continue

      upsertInstalledIntegration({
        project_id,
        integration_id: 'google',
        status: 'connected',
        installed_at: Date.now(),
      })
      setInstalledStatus(project_id, 'google', 'connected', account, Date.now(), null)
      console.info(`[integrations] migrated existing Google OAuth for project ${project_id} (${account})`)
    }
  }
}

export function mountIntegrationsRoutes(): Router {
  const router = Router()

  // Initialize installed-store with the bot DB write handle
  const bdb = getBotDbWrite()
  if (bdb) installedStoreInit(bdb)

  // Load catalog from disk
  const catalogDir = path.join(process.cwd(), 'integrations', 'catalog')
  loadCatalog(catalogDir)

  // Seed installed_integrations from pre-existing OAuth connections
  migrateExistingOAuthConnections()

  router.get('/catalog', (_req: Request, res: Response) => {
    res.json({ integrations: getAllCatalogEntries() })
  })

  router.get('/catalog/:id', (req: Request, res: Response) => {
    const m = getCatalogEntry(String(req.params['id']))
    if (!m) { res.status(404).json({ error: 'not_found' }); return }
    res.json(m)
  })

  router.get(
    '/installed',
    requireProjectRole('viewer', (req) =>
      typeof req.query['project_id'] === 'string' ? (req.query['project_id'] as string) : null,
    ),
    (req: Request, res: Response) => {
      const projectId = typeof req.query['project_id'] === 'string' ? req.query['project_id'] : undefined
      if (!projectId) { res.status(400).json({ error: 'project_id_required' }); return }
      const rows = listInstalledForProject(projectId)
      const hydrated = rows.map(r => ({ ...r, manifest: getCatalogEntry(r.integration_id) ?? null }))
      res.json({ installed: hydrated })
    },
  )

  router.post('/install/:id', requireProjectRole('editor', (req) =>
    typeof req.body?.project_id === 'string' ? (req.body.project_id as string) : null,
  ), async (req: Request, res: Response) => {
    const id = String(req.params['id'])
    const projectId = typeof req.body.project_id === 'string' ? (req.body.project_id as string) : undefined
    const credentials = (req.body.credentials ?? {}) as Record<string, string>
    if (!projectId) { res.status(400).json({ error: 'project_id_required' }); return }

    const manifest = getCatalogEntry(id)
    if (!manifest) { res.status(404).json({ error: 'unknown_integration' }); return }

    // Validate required credentials provided
    const missing: string[] = []
    for (const f of manifest.setup.credentials_required) {
      if (!(f.key in credentials) || !credentials[f.key]) missing.push(f.key)
    }
    if (missing.length > 0) {
      res.status(400).json({ error: 'missing_credentials', missing })
      return
    }

    // Persist credentials encrypted, restore archived rows
    try {
      const bdbWrite = getBotDbWrite()
      for (const f of manifest.setup.credentials_required) {
        setOAuthCredential(projectId, f.service, f.key, credentials[f.key]!)
        if (bdbWrite) {
          bdbWrite.prepare(
            'UPDATE project_credentials SET archived_at = NULL WHERE project_id = ? AND service = ? AND key = ?'
          ).run(projectId, f.service, f.key)
        }
      }
    } catch (err: any) {
      res.status(500).json({ error: 'credential_write_failed', message: String(err.message ?? err) })
      return
    }

    upsertInstalledIntegration({
      project_id: projectId, integration_id: id, status: 'verifying', installed_at: Date.now(),
    })

    if (manifest.kind === 'api_key') {
      // Filter to manifest-declared keys only -- prevents extraneous values from affecting sanitization
      const filtered: Record<string, string> = {}
      for (const f of manifest.setup.credentials_required) {
        if (credentials[f.key] !== undefined) filtered[f.key] = credentials[f.key]!
      }
      const result = await verifyApiKeyIntegration(manifest, filtered)
      setInstalledStatus(projectId, id, result.status, result.account ?? null, Date.now(), result.error ?? null)
      res.json({ status: result.status, account: result.account, error: result.error })
      return
    }

    if (manifest.kind === 'oauth') {
      const returnUrl = typeof req.body.return_url === 'string' ? (req.body.return_url as string) : '/#integrations'
      const url = buildOAuthAuthUrl(projectId, manifest, returnUrl)
      res.json({ status: 'redirect', auth_url: url })
      return
    }

    if (manifest.kind === 'mcp_server') {
      // Remap credentials from field-key format to service.key format expected by buildMcpEnv
      const remapped: Record<string, string> = {}
      for (const f of manifest.setup.credentials_required) {
        if (credentials[f.key] !== undefined) remapped[`${f.service}.${f.key}`] = credentials[f.key]!
      }
      const result = await verifyMcpServerIntegration(manifest, remapped)
      setInstalledStatus(projectId, id, result.status, result.account ?? null, Date.now(), result.error ?? null)
      res.json({ status: result.status, error: result.error })
      return
    }
    res.status(501).json({ error: 'unknown_kind' })
  })

  router.post('/verify/:id', requireProjectRole('viewer', (req) =>
    typeof req.query['project_id'] === 'string' ? (req.query['project_id'] as string) : null,
  ), async (req: Request, res: Response) => {
    const id = String(req.params['id'])
    const projectId = typeof req.query['project_id'] === 'string' ? req.query['project_id'] : undefined
    if (!projectId) { res.status(400).json({ error: 'project_id_required' }); return }
    const manifest = getCatalogEntry(id)
    if (!manifest) { res.status(404).json({ error: 'unknown_integration' }); return }

    if (manifest.kind === 'api_key') {
      const decrypted = await decryptProjectCreds(projectId, manifest.setup.credentials_required)
      if (decrypted.error) {
        res.status(400).json(decrypted.error)
        return
      }
      const result = await verifyApiKeyIntegration(manifest, decrypted.creds!)
      setInstalledStatus(projectId, id, result.status, result.account ?? null, Date.now(), result.error ?? null)
      res.json({ status: result.status, account: result.account, error: result.error })
      return
    }

    if (manifest.kind === 'oauth') {
      const accounts = listConnectedOAuthAccounts(projectId, manifest)
      const connectedAcc = accounts.find(a => a.connected)
      const status = connectedAcc ? 'connected' : 'error'
      const account = connectedAcc ? connectedAcc.account : null
      const error = connectedAcc ? null : 'no_connected_accounts'
      setInstalledStatus(projectId, id, status as any, account, Date.now(), error)
      res.json({ status, account, error })
      return
    }

    if (manifest.kind === 'mcp_server') {
      const decrypted = await decryptProjectCreds(projectId, manifest.setup.credentials_required)
      if (decrypted.error) {
        res.status(400).json(decrypted.error)
        return
      }
      const result = await verifyMcpServerIntegration(manifest, decrypted.creds!)
      setInstalledStatus(projectId, id, result.status, result.account ?? null, Date.now(), result.error ?? null)
      res.json({ status: result.status, error: result.error })
      return
    }
    res.status(501).json({ error: 'unknown_kind' })
  })

  router.delete('/installed/:id', requireProjectRole('editor', (req) =>
    typeof req.query['project_id'] === 'string' ? (req.query['project_id'] as string) : null,
  ), (req: Request, res: Response) => {
    const id = String(req.params['id'])
    const projectId = typeof req.query['project_id'] === 'string' ? req.query['project_id'] : undefined
    if (!projectId) { res.status(400).json({ error: 'project_id_required' }); return }
    const manifest = getCatalogEntry(id)
    if (!manifest) { res.status(404).json({ error: 'unknown_integration' }); return }

    // Archive credentials instead of deleting
    const bdbWrite = getBotDbWrite()
    if (bdbWrite) {
      const now = Date.now()
      for (const f of manifest.setup.credentials_required) {
        bdbWrite.prepare(
          'UPDATE project_credentials SET archived_at = ? WHERE project_id = ? AND service = ? AND key = ?'
        ).run(now, projectId, f.service, f.key)
      }
    }

    deleteInstalledIntegration(projectId, id)
    res.json({ success: true })
  })

  return router
}
