import jwt from 'jsonwebtoken'
import {
  getServiceCredentials,
  setCredential,
  listServices,
  deleteService,
} from '../credentials.js'
import { logger } from '../logger.js'
import type {
  ServiceManifest,
  IntegrationStatus,
  OAuthStartResult,
} from './types.js'

interface OAuthStatePayload {
  projectId: string
  service: string
  returnUrl?: string
  telegramChatId?: number
  scopes: string[]
}

export class IntegrationEngine {
  private registry = new Map<string, ServiceManifest>()
  private signingSecret: string

  constructor(signingSecret: string) {
    this.signingSecret = signingSecret
  }

  register(manifest: ServiceManifest): void {
    if (this.registry.has(manifest.name)) {
      throw new Error(`Service ${manifest.name} already registered`)
    }
    this.registry.set(manifest.name, manifest)
    logger.info({ service: manifest.name }, 'Integration service registered')
  }

  listServices(): ServiceManifest[] {
    return Array.from(this.registry.values())
  }

  getManifest(serviceName: string): ServiceManifest | undefined {
    return this.registry.get(serviceName)
  }

  startOAuth(
    projectId: string,
    serviceName: string,
    opts?: {
      account?: string
      scopes?: string[]
      returnUrl?: string
      telegramChatId?: number
    },
  ): OAuthStartResult {
    const manifest = this.registry.get(serviceName)
    if (!manifest) throw new Error(`Service ${serviceName} not registered`)
    if (!manifest.oauth) throw new Error(`Service ${serviceName} does not support OAuth`)

    const scopes = opts?.scopes ?? manifest.oauth.requiredScopes

    const payload: OAuthStatePayload = {
      projectId,
      service: serviceName,
      returnUrl: opts?.returnUrl,
      telegramChatId: opts?.telegramChatId,
      scopes,
    }

    const state = jwt.sign(payload, this.signingSecret, { expiresIn: '10m' })

    const params = new URLSearchParams({
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes.join(' '),
      state,
    })

    const url = `${manifest.oauth.authUrl}?${params.toString()}`

    return { url, state }
  }

  verifyState(state: string): OAuthStatePayload {
    return jwt.verify(state, this.signingSecret) as OAuthStatePayload
  }

  storeTokens(
    projectId: string,
    serviceName: string,
    account: string,
    tokens: {
      access_token: string
      refresh_token: string
      expiry_date: number
      scope: string
    },
  ): void {
    const serviceKey = `${serviceName}:${account}`
    setCredential(projectId, serviceKey, 'access_token', tokens.access_token)
    setCredential(projectId, serviceKey, 'refresh_token', tokens.refresh_token)
    setCredential(projectId, serviceKey, 'expiry', String(tokens.expiry_date))
    setCredential(projectId, serviceKey, 'scopes', tokens.scope)
    setCredential(projectId, serviceKey, 'account_email', account)
    setCredential(projectId, serviceKey, 'status', 'connected')
    logger.info({ projectId, service: serviceName, account }, 'Integration tokens stored')
  }

  getTokens(
    projectId: string,
    serviceName: string,
    account?: string,
  ): { access_token: string; refresh_token: string; expiry: number; scopes: string; account_email: string } | null {
    const resolvedAccount = account ?? this.resolveDefaultAccount(projectId, serviceName)
    if (!resolvedAccount) return null

    const serviceKey = `${serviceName}:${resolvedAccount}`
    const creds = getServiceCredentials(projectId, serviceKey)

    if (!creds.access_token || !creds.refresh_token) return null

    return {
      access_token: creds.access_token,
      refresh_token: creds.refresh_token,
      expiry: Number(creds.expiry || 0),
      scopes: creds.scopes || '',
      account_email: creds.account_email || resolvedAccount,
    }
  }

  updateAccessToken(
    projectId: string,
    serviceName: string,
    account: string,
    newAccessToken: string,
    newExpiry: number,
  ): void {
    const serviceKey = `${serviceName}:${account}`
    setCredential(projectId, serviceKey, 'access_token', newAccessToken)
    setCredential(projectId, serviceKey, 'expiry', String(newExpiry))
  }

  markDisconnected(projectId: string, serviceName: string, account: string): void {
    const serviceKey = `${serviceName}:${account}`
    setCredential(projectId, serviceKey, 'status', 'disconnected')
    setCredential(projectId, serviceKey, 'disconnected_at', String(Date.now()))
    logger.warn({ projectId, service: serviceName, account }, 'Integration marked disconnected')
  }

  getStatus(projectId: string, serviceName?: string): IntegrationStatus[] {
    const services = listServices(projectId)
    const results: IntegrationStatus[] = []

    for (const svc of services) {
      const colonIdx = svc.indexOf(':')
      if (colonIdx === -1) continue

      const svcName = svc.substring(0, colonIdx)
      const account = svc.substring(colonIdx + 1)

      if (serviceName && svcName !== serviceName) continue
      if (!this.registry.has(svcName)) continue

      const creds = getServiceCredentials(projectId, svc)

      results.push({
        service: svcName,
        account,
        status: (creds.status as 'connected' | 'disconnected') || 'disconnected',
        scopes: creds.scopes ? creds.scopes.split(',') : [],
        disconnectedAt: creds.disconnected_at ? Number(creds.disconnected_at) : undefined,
      })
    }

    return results
  }

  disconnect(projectId: string, serviceName: string, account?: string): void {
    const resolvedAccount = account ?? this.resolveDefaultAccount(projectId, serviceName)
    if (!resolvedAccount) return

    const serviceKey = `${serviceName}:${resolvedAccount}`
    deleteService(projectId, serviceKey)
    logger.info({ projectId, service: serviceName, account: resolvedAccount }, 'Integration disconnected')
  }

  listAccounts(projectId: string, serviceName: string): string[] {
    const services = listServices(projectId)
    const prefix = `${serviceName}:`
    return services
      .filter((s) => s.startsWith(prefix))
      .map((s) => s.substring(prefix.length))
  }

  private resolveDefaultAccount(projectId: string, serviceName: string): string | null {
    const accounts = this.listAccounts(projectId, serviceName)
    if (accounts.length === 1) return accounts[0]
    return null
  }
}
