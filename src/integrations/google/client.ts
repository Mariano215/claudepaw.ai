import { google } from 'googleapis'
import { IntegrationEngine } from '../engine.js'
import { IntegrationNotConnectedError, TokenExpiredError } from '../errors.js'
import { logger } from '../../logger.js'
import { DASHBOARD_URL, DASHBOARD_API_TOKEN, BOT_API_TOKEN } from '../../config.js'

const REFRESH_BUFFER_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Preferred auth token used when talking to the dashboard /access-token endpoint.
 * BOT_API_TOKEN is the dedicated bot identity; DASHBOARD_API_TOKEN is the admin
 * bootstrap token. Either works because the endpoint accepts bot or admin.
 */
function dashboardAuthToken(): string | undefined {
  return BOT_API_TOKEN || DASHBOARD_API_TOKEN || undefined
}

export class GoogleClient {
  constructor(
    private engine: IntegrationEngine,
    private clientId: string,
    private clientSecret: string,
  ) {}

  getOAuth2Client(
    projectId: string,
    account?: string,
  ): InstanceType<typeof google.auth.OAuth2> {
    const tokens = this.engine.getTokens(projectId, 'google', account)

    if (!tokens) {
      if (!account) {
        const accounts = this.engine.listAccounts(projectId, 'google')
        if (accounts.length > 1) {
          throw new IntegrationNotConnectedError(
            projectId,
            'google',
            `Multiple accounts connected (${accounts.join(', ')}). Please specify --account.`,
          )
        }
      }
      throw new IntegrationNotConnectedError(projectId, 'google', account)
    }

    const oauth2 = new google.auth.OAuth2(this.clientId, this.clientSecret)
    oauth2.setCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry,
    })

    return oauth2
  }

  /**
   * Returns an OAuth2 client with a valid access token. Prefers the dashboard's
   * /access-token endpoint (source of truth for OAuth state, handles refresh
   * centrally, avoids stale-token drift between dashboard host and bot host).
   * Falls back to a local refresh using the stored refresh_token if the
   * dashboard is unreachable or not configured.
   */
  async ensureFreshToken(
    projectId: string,
    account?: string,
  ): Promise<InstanceType<typeof google.auth.OAuth2>> {
    const tokens = this.engine.getTokens(projectId, 'google', account)
    if (!tokens) throw new IntegrationNotConnectedError(projectId, 'google', account)

    const resolvedAccount = tokens.account_email

    // --- Preferred path: dashboard-owned refresh ---
    if (this.canUseDashboard()) {
      try {
        const fresh = await this.fetchAccessTokenFromDashboard(projectId, resolvedAccount)
        const oauth2 = new google.auth.OAuth2(this.clientId, this.clientSecret)
        oauth2.setCredentials({
          access_token: fresh.access_token,
          expiry_date: fresh.expiry_date,
        })
        // Mirror fresh access_token to local store so any readonly code path
        // (e.g. getOAuth2Client) sees a coherent snapshot without needing to
        // hit the dashboard itself.
        try {
          this.engine.updateAccessToken(
            projectId,
            'google',
            resolvedAccount,
            fresh.access_token,
            fresh.expiry_date,
          )
        } catch (mirrorErr) {
          logger.warn(
            { projectId, account: resolvedAccount, err: String(mirrorErr) },
            'Failed to mirror dashboard token to local store (non-fatal)',
          )
        }
        return oauth2
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.warn(
          { projectId, account: resolvedAccount, err: errMsg },
          'Dashboard access-token fetch failed, falling back to local refresh',
        )
        // fall through to local refresh
      }
    }

    // --- Fallback path: local refresh using stored refresh_token ---
    const oauth2 = new google.auth.OAuth2(this.clientId, this.clientSecret)
    oauth2.setCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry,
    })

    if (tokens.expiry < Date.now() + REFRESH_BUFFER_MS) {
      try {
        const { credentials } = await oauth2.refreshAccessToken()
        oauth2.setCredentials(credentials)
        this.engine.updateAccessToken(
          projectId,
          'google',
          resolvedAccount,
          credentials.access_token!,
          credentials.expiry_date!,
        )
        logger.info({ projectId, account: resolvedAccount }, 'Google token refreshed locally')
      } catch (err) {
        // Only mark disconnected for hard auth failures (invalid_grant, token revoked).
        // Transient network errors should not permanently disable the integration.
        const errMsg = err instanceof Error ? err.message : String(err)
        const isAuthFailure = /invalid_grant|token.*revok|invalid.*token|unauthorized/i.test(errMsg)
        if (isAuthFailure) {
          this.engine.markDisconnected(projectId, 'google', resolvedAccount)
          throw new TokenExpiredError(projectId, 'google', resolvedAccount)
        }
        // Transient failure: log and continue with the existing (possibly expired) token
        logger.warn({ projectId, account: resolvedAccount, err: errMsg }, 'Google token refresh failed transiently, continuing with existing token')
      }
    }

    return oauth2
  }

  resolveAccount(projectId: string, account?: string): string {
    if (account) return account
    const accounts = this.engine.listAccounts(projectId, 'google')
    if (accounts.length === 1) return accounts[0]
    if (accounts.length === 0) throw new IntegrationNotConnectedError(projectId, 'google')
    throw new IntegrationNotConnectedError(
      projectId,
      'google',
      `Multiple accounts connected (${accounts.join(', ')}). Please specify --account.`,
    )
  }

  private canUseDashboard(): boolean {
    return Boolean(DASHBOARD_URL && dashboardAuthToken())
  }

  private async fetchAccessTokenFromDashboard(
    projectId: string,
    account: string,
  ): Promise<{ access_token: string; expiry_date: number }> {
    const token = dashboardAuthToken()
    if (!token) throw new Error('No dashboard auth token configured')

    const url =
      `${DASHBOARD_URL}/api/v1/integrations/google/access-token` +
      `?project_id=${encodeURIComponent(projectId)}` +
      `&account=${encodeURIComponent(account)}`

    const res = await fetch(url, {
      headers: { 'x-dashboard-token': token },
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(
        `Dashboard access-token fetch failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
      )
    }

    const data = (await res.json()) as { access_token?: string; expiry_date?: number }
    if (!data.access_token || typeof data.expiry_date !== 'number') {
      throw new Error('Dashboard returned incomplete access token payload')
    }
    return { access_token: data.access_token, expiry_date: data.expiry_date }
  }
}
