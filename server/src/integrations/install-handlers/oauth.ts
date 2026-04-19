import type { IntegrationManifest } from '../schema.js'
import { getOAuthServiceCredentials, listOAuthServices } from '../../db.js'

export type OAuthAccountStatus = {
  account: string
  connected: boolean
}

/**
 * Read the encrypted OAuth credentials for a project + manifest's provider,
 * and report which accounts are connected. The OAuth callback in routes.ts
 * already wrote them via setOAuthCredential() with key `<provider>:<email>`.
 */
export function listConnectedOAuthAccounts(projectId: string, manifest: IntegrationManifest): OAuthAccountStatus[] {
  if (manifest.kind !== 'oauth' || !manifest.oauth) return []
  const provider = manifest.oauth.provider
  const services = listOAuthServices(projectId)
  const prefix = `${provider}:`
  const out: OAuthAccountStatus[] = []
  for (const svc of services) {
    if (!svc.startsWith(prefix)) continue
    const account = svc.slice(prefix.length)
    const creds = getOAuthServiceCredentials(projectId, svc)
    out.push({
      account,
      connected: (creds.status ?? 'disconnected') === 'connected',
    })
  }
  return out
}

/**
 * Build the URL the frontend should redirect to in order to start the OAuth flow.
 * Delegates to the existing /integrations/:service/auth route.
 */
export function buildOAuthAuthUrl(projectId: string, manifest: IntegrationManifest, returnUrl: string): string {
  if (manifest.kind !== 'oauth' || !manifest.oauth) throw new Error('not an oauth manifest')
  const provider = manifest.oauth.provider
  const params = new URLSearchParams({ project_id: projectId, return_url: returnUrl })
  return `/api/v1/integrations/${encodeURIComponent(provider)}/auth?${params.toString()}`
}
