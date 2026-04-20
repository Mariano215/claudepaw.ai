import { createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getBotDb, recordMetric, getAllProjectIntegrations, upsertMetricHealth } from './db.js'
import { logger } from './logger.js'
import { quotaFetch, QuotaCooldownError } from './quota.js'

function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer))
}

// ---------------------------------------------------------------------------
// Expected metric keys per platform - must match server/public/app.js
// platformMetricKeySuffixes(). The collector pads missing keys with value 0
// and metadata { unavailable: true, reason } so the dashboard renders
// "n/a" instead of "--" and the healer knows what's broken.
// ---------------------------------------------------------------------------

const EXPECTED_SUFFIXES: Record<string, string[]> = {
  'youtube':   ['subscribers', 'views', 'videos'],
  'x-twitter': ['followers', 'tweets', 'following'],
  'linkedin':  ['followers', 'impressions', 'engagement'],
  'website':   ['sessions', 'users', 'bounce'],
  'github':    ['stars', 'forks', 'issues'],
  'meta':      ['likes', 'reach', 'engagement'],
  'instagram': ['followers', 'reach', 'engagement'],
  'shopify':   ['orders', 'revenue', 'visitors'],
  'tiktok':    ['followers', 'views', 'likes'],
}

// ---------------------------------------------------------------------------
// Credential decryption
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm'

function decryptCredential(value: Buffer, iv: Buffer, tag: Buffer): string | null {
  const keyHex = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!keyHex || keyHex.length !== 64) return null
  const key = Buffer.from(keyHex, 'hex')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(value), decipher.final()])
  return decrypted.toString('utf8')
}

function getCredential(
  botDb: Database.Database,
  projectId: string,
  service: string,
  credKey: string
): string | null {
  const row = botDb
    .prepare('SELECT value, iv, tag FROM project_credentials WHERE project_id = ? AND service = ? AND key = ?')
    .get(projectId, service, credKey) as { value: Buffer; iv: Buffer; tag: Buffer } | undefined
  if (!row) return null
  try {
    const val = decryptCredential(row.value, row.iv, row.tag)
    return val && val.length > 0 ? val : null  // treat empty strings as missing
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MetricEntry {
  key: string
  value: number
  unavailable?: boolean
  reason?: string
}

interface CollectResult {
  entries: MetricEntry[]
  error?: string
}

/** Last error message recorded by each collector function, keyed by prefix.
 * The orchestrator reads this to populate metric_health.reason so the dashboard
 * shows the real platform error instead of a generic "missing metrics" string. */
const lastCollectError: Record<string, string> = {}

function noteError(prefix: string, msg: string): void {
  lastCollectError[prefix] = msg.length > 240 ? msg.slice(0, 240) + '…' : msg
}
function clearError(prefix: string): void {
  delete lastCollectError[prefix]
}

/** Build a placeholder entry the dashboard renders as "n/a" with hover tooltip. */
function unavailableEntry(prefix: string, suffix: string, reason: string): MetricEntry {
  return { key: `${prefix}-${suffix}`, value: 0, unavailable: true, reason }
}

/** Pad collected entries with placeholders for any expected suffix that's missing. */
function padExpected(platform: string, prefix: string, entries: MetricEntry[], reason: string): MetricEntry[] {
  const suffixes = EXPECTED_SUFFIXES[platform]
  if (!suffixes) return entries
  const have = new Set(entries.map(e => e.key))
  const padded = [...entries]
  for (const sfx of suffixes) {
    const key = `${prefix}-${sfx}`
    if (!have.has(key)) padded.push({ key, value: 0, unavailable: true, reason })
  }
  return padded
}

// ---------------------------------------------------------------------------
// Platform collectors
// ---------------------------------------------------------------------------

async function collectYouTube(apiKey: string, channelId: string, prefix: string): Promise<MetricEntry[]> {
  try {
    const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${channelId}&key=${apiKey}`
    const res = await quotaFetch('youtube', url, { endpoint: '/youtube/v3/channels' })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200)
      throw new Error(`YouTube API ${res.status}: ${body}`)
    }
    const data = await res.json() as { items?: { statistics: Record<string, string> }[] }
    const stats = data.items?.[0]?.statistics
    if (!stats) throw new Error('No channel statistics in YouTube response (channel ID may be invalid)')
    clearError(prefix)
    return [
      { key: `${prefix}-subscribers`, value: Number(stats.subscriberCount ?? 0) },
      { key: `${prefix}-views`,       value: Number(stats.viewCount ?? 0) },
      { key: `${prefix}-videos`,      value: Number(stats.videoCount ?? 0) },
    ]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    noteError(prefix, msg)
    logger.error({ err, prefix }, 'collectYouTube failed')
    return []
  }
}

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

async function collectTwitter(
  apiKey: string,
  apiSecret: string,
  accessToken: string,
  accessSecret: string,
  prefix: string
): Promise<MetricEntry[]> {
  try {
    const method = 'GET'
    const baseUrl = 'https://api.twitter.com/2/users/me'
    const queryParams: Record<string, string> = { 'user.fields': 'public_metrics' }

    const nonce = randomBytes(16).toString('hex')
    const timestamp = String(Math.floor(Date.now() / 1000)) // OAuth1.0a requires Unix epoch seconds (RFC 5849)

    const oauthParams: Record<string, string> = {
      oauth_consumer_key:     apiKey,
      oauth_nonce:            nonce,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp:        timestamp,
      oauth_token:            accessToken,
      oauth_version:          '1.0',
    }

    // Build parameter string: all oauth params + query params, sorted alphabetically
    const allParams: Record<string, string> = { ...queryParams, ...oauthParams }
    const paramString = Object.keys(allParams)
      .sort()
      .map(k => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
      .join('&')

    const sigBaseString = [
      method,
      percentEncode(baseUrl),
      percentEncode(paramString),
    ].join('&')

    const signingKey = `${percentEncode(apiSecret)}&${percentEncode(accessSecret)}`
    const signature = createHmac('sha1', signingKey).update(sigBaseString).digest('base64')

    const authHeader = [
      `OAuth oauth_consumer_key="${percentEncode(apiKey)}"`,
      `oauth_nonce="${percentEncode(nonce)}"`,
      `oauth_signature="${percentEncode(signature)}"`,
      `oauth_signature_method="HMAC-SHA1"`,
      `oauth_timestamp="${timestamp}"`,
      `oauth_token="${percentEncode(accessToken)}"`,
      `oauth_version="1.0"`,
    ].join(', ')

    const url = `${baseUrl}?${new URLSearchParams(queryParams).toString()}`
    const res = await quotaFetch('twitter', url, { headers: { Authorization: authHeader }, endpoint: '/2/users/me' })
    if (!res.ok) throw new Error(`Twitter API ${res.status}: ${await res.text()}`)

    const data = await res.json() as { data?: { public_metrics?: { followers_count: number; tweet_count: number; following_count: number } } }
    const metrics = data.data?.public_metrics
    if (!metrics) throw new Error('No public_metrics in Twitter response')

    clearError(prefix)
    return [
      { key: `${prefix}-followers`, value: metrics.followers_count },
      { key: `${prefix}-tweets`,    value: metrics.tweet_count },
      { key: `${prefix}-following`, value: metrics.following_count },
    ]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    noteError(prefix, msg)
    logger.error({ err, prefix }, 'collectTwitter failed')
    return []
  }
}

async function collectLinkedIn(accessToken: string, prefix: string): Promise<MetricEntry[]> {
  // LinkedIn moved the "who am I?" endpoint off the legacy /v2/me (which
  // requires r_liteprofile) to the OpenID Connect /v2/userinfo endpoint
  // (which uses openid+profile+email and is included with modern OAuth).
  // Newer tokens issued for posting only have w_member_social + openid
  // scopes, so /v2/me returns 403 ACCESS_DENIED even though the token is
  // perfectly valid. Probe /v2/userinfo first, fall back to /v2/me so older
  // r_liteprofile tokens still work.
  //
  // The endpoint is only used as a liveness check - LinkedIn does not expose
  // follower/impression/engagement numbers without Marketing Developer
  // Platform approval, so those three keys stay as "unavailable" placeholders
  // regardless of which probe succeeds.
  const probes = [
    { url: 'https://api.linkedin.com/v2/userinfo', endpoint: '/v2/userinfo' },
    { url: 'https://api.linkedin.com/v2/me',       endpoint: '/v2/me' },
  ]
  let lastStatus = 0
  let lastBody  = ''
  for (const probe of probes) {
    try {
      const res = await quotaFetch('linkedin', probe.url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        endpoint: probe.endpoint,
      })
      if (res.ok) {
        const reason = 'LinkedIn Marketing API not approved - basic auth only'
        clearError(prefix)
        return [
          { key: `${prefix}-status`, value: 1 },
          unavailableEntry(prefix, 'followers',   reason),
          unavailableEntry(prefix, 'impressions', reason),
          unavailableEntry(prefix, 'engagement',  reason),
        ]
      }
      lastStatus = res.status
      lastBody   = (await res.text()).slice(0, 200)
      // Only a 403 is the "wrong scope" signal worth retrying with another
      // probe. 401/429/5xx are token/quota problems — bail immediately.
      if (res.status !== 403) break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      noteError(prefix, msg)
      logger.error({ err, prefix }, 'collectLinkedIn probe failed')
      return []
    }
  }
  const msg = `LinkedIn API ${lastStatus}: ${lastBody}`
  noteError(prefix, msg)
  logger.error({ prefix, lastStatus, lastBody }, 'collectLinkedIn failed (both /v2/userinfo and /v2/me)')
  return []
}

async function collectMeta(pageToken: string, pageId: string, prefix: string): Promise<MetricEntry[]> {
  try {
    const pageUrl = `https://graph.facebook.com/v22.0/${pageId}?fields=fan_count,followers_count`
    const res = await quotaFetch('meta', pageUrl, { endpoint: '/page', headers: { 'Authorization': `Bearer ${pageToken}` } })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200)
      throw new Error(`Meta Graph API ${res.status}: ${body}`)
    }
    const data = await res.json() as { fan_count?: number; followers_count?: number }

    const entries: MetricEntry[] = [
      { key: `${prefix}-likes`,     value: data.fan_count ?? 0 },
      { key: `${prefix}-followers`, value: data.followers_count ?? 0 },
    ]

    // Try page insights for reach + engagement (requires page_read_engagement scope)
    try {
      const insightsUrl = `https://graph.facebook.com/v22.0/${pageId}/insights?metric=page_impressions_unique,page_post_engagements&period=day`
      const insRes = await quotaFetch('meta', insightsUrl, { endpoint: '/page/insights', headers: { 'Authorization': `Bearer ${pageToken}` } })
      if (insRes.ok) {
        const insData = await insRes.json() as { data?: { name?: string; values?: { value: number }[] }[] }
        const series = insData.data ?? []
        const reachSeries = series.find(s => s.name === 'page_impressions_unique')?.values
        const engSeries   = series.find(s => s.name === 'page_post_engagements')?.values
        const reach = reachSeries && reachSeries.length > 0 ? reachSeries[reachSeries.length - 1].value : null
        const eng   = engSeries   && engSeries.length   > 0 ? engSeries[engSeries.length - 1].value     : null
        entries.push(reach !== null
          ? { key: `${prefix}-reach`, value: reach }
          : unavailableEntry(prefix, 'reach', 'Meta page_impressions_unique unavailable'))
        entries.push(eng !== null
          ? { key: `${prefix}-engagement`, value: eng }
          : unavailableEntry(prefix, 'engagement', 'Meta page_post_engagements unavailable'))
      } else {
        const reason = `Meta insights ${insRes.status} - need page_read_engagement scope`
        entries.push(unavailableEntry(prefix, 'reach',      reason))
        entries.push(unavailableEntry(prefix, 'engagement', reason))
      }
    } catch (insErr) {
      logger.warn({ insErr, prefix }, 'Meta page insights unavailable')
      entries.push(unavailableEntry(prefix, 'reach',      'Meta insights API error'))
      entries.push(unavailableEntry(prefix, 'engagement', 'Meta insights API error'))
    }

    clearError(prefix)
    return entries
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    noteError(prefix, msg)
    logger.error({ err, prefix }, 'collectMeta failed')
    return []
  }
}

async function collectInstagram(igUserId: string, accessToken: string, prefix: string): Promise<MetricEntry[]> {
  try {
    const baseUrl = `https://graph.facebook.com/v22.0/${igUserId}?fields=followers_count,media_count`
    const res = await quotaFetch('instagram', baseUrl, { endpoint: '/ig/profile', headers: { 'Authorization': `Bearer ${accessToken}` } })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200)
      throw new Error(`Instagram API ${res.status}: ${body}`)
    }
    const data = await res.json() as { followers_count?: number; media_count?: number }

    const entries: MetricEntry[] = [
      { key: `${prefix}-followers`, value: data.followers_count ?? 0 },
      { key: `${prefix}-media`,     value: data.media_count ?? 0 },
    ]

    // Try insights for reach + engagement (accounts/total_interactions)
    try {
      const insightsUrl = `https://graph.facebook.com/v22.0/${igUserId}/insights?metric=reach,accounts_engaged&period=day&metric_type=total_value`
      const insRes = await quotaFetch('instagram', insightsUrl, { endpoint: '/ig/insights', headers: { 'Authorization': `Bearer ${accessToken}` } })
      if (insRes.ok) {
        const insData = await insRes.json() as { data?: { name?: string; total_value?: { value: number } }[] }
        const series = insData.data ?? []
        const reach = series.find(s => s.name === 'reach')?.total_value?.value ?? null
        const eng   = series.find(s => s.name === 'accounts_engaged')?.total_value?.value ?? null
        entries.push(reach !== null
          ? { key: `${prefix}-reach`, value: reach }
          : unavailableEntry(prefix, 'reach', 'Instagram reach unavailable'))
        entries.push(eng !== null
          ? { key: `${prefix}-engagement`, value: eng }
          : unavailableEntry(prefix, 'engagement', 'Instagram accounts_engaged unavailable'))
      } else {
        const reason = `Instagram insights ${insRes.status} - check permissions`
        entries.push(unavailableEntry(prefix, 'reach',      reason))
        entries.push(unavailableEntry(prefix, 'engagement', reason))
      }
    } catch (insErr) {
      logger.warn({ insErr, prefix }, 'Instagram insights unavailable')
      entries.push(unavailableEntry(prefix, 'reach',      'Instagram insights API error'))
      entries.push(unavailableEntry(prefix, 'engagement', 'Instagram insights API error'))
    }

    clearError(prefix)
    return entries
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    noteError(prefix, msg)
    logger.error({ err, prefix }, 'collectInstagram failed')
    return []
  }
}

async function collectGoogleAnalytics(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  propertyId: string,
  prefix: string
): Promise<MetricEntry[]> {
  try {
    // Exchange refresh token for access token
    const tokenRes = await quotaFetch('google-analytics', 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     clientId,
        client_secret: clientSecret,
      }).toString(),
      endpoint: '/oauth2/token',
    })
    if (!tokenRes.ok) {
      const body = (await tokenRes.text()).slice(0, 200)
      throw new Error(`GA token exchange ${tokenRes.status}: ${body}`)
    }
    const tokenData = await tokenRes.json() as { access_token: string }
    const accessToken = tokenData.access_token

    // Run report - use a 7-day range so a slow data day still returns rows
    const reportRes = await quotaFetch(
      'google-analytics',
      `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
      {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
          metrics: [
            { name: 'sessions' },
            { name: 'totalUsers' },
            { name: 'bounceRate' },
          ],
        }),
        endpoint: '/v1beta/properties/runReport',
      }
    )
    if (!reportRes.ok) {
      const body = (await reportRes.text()).slice(0, 240)
      throw new Error(`GA report ${reportRes.status}: ${body}`)
    }

    const reportData = await reportRes.json() as {
      rows?: { metricValues: { value: string }[] }[]
    }
    const metricValues = reportData.rows?.[0]?.metricValues
    if (!metricValues || metricValues.length < 3) {
      // Empty report - account is connected but the property has no traffic
      // in the requested window. Surface as unavailable, NOT as a hard error.
      const reason = 'GA property returned no rows for last 7 days'
      noteError(prefix, reason)
      return [
        unavailableEntry(prefix, 'sessions', reason),
        unavailableEntry(prefix, 'users',    reason),
        unavailableEntry(prefix, 'bounce',   reason),
      ]
    }

    clearError(prefix)
    return [
      { key: `${prefix}-sessions`, value: Number(metricValues[0].value) },
      { key: `${prefix}-users`,    value: Number(metricValues[1].value) },
      { key: `${prefix}-bounce`,   value: Number(metricValues[2].value) },
    ]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    noteError(prefix, msg)
    logger.error({ err, prefix }, 'collectGoogleAnalytics failed')
    return []
  }
}

async function collectShopify(storeUrl: string, accessToken: string, prefix: string): Promise<MetricEntry[]> {
  try {
    // Tolerate stored values like "https://store.myshopify.com/" or
    // "store.myshopify.com" - normalize to bare host so the template literal
    // never produces "https://https://...".
    const host = storeUrl
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '')
      .trim()
    if (!host) throw new Error('Shopify store_url is empty after normalization')

    const headers = { 'X-Shopify-Access-Token': accessToken }
    const todayISO = new Date().toISOString().split('T')[0]
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    // Orders today
    const countRes = await quotaFetch(
      'shopify',
      `https://${host}/admin/api/2024-01/orders/count.json?status=any&created_at_min=${todayISO}`,
      { headers, endpoint: '/admin/orders/count' }
    )
    if (!countRes.ok) {
      const body = (await countRes.text()).slice(0, 200)
      throw new Error(`Shopify orders count ${countRes.status}: ${body}`)
    }
    const countData = await countRes.json() as { count: number }
    const ordersToday = countData.count ?? 0

    // Revenue (30-day average)
    const ordersRes = await quotaFetch(
      'shopify',
      `https://${host}/admin/api/2024-01/orders.json?status=any&created_at_min=${thirtyDaysAgo}&fields=total_price`,
      { headers, endpoint: '/admin/orders' }
    )
    if (!ordersRes.ok) {
      const body = (await ordersRes.text()).slice(0, 200)
      throw new Error(`Shopify orders list ${ordersRes.status}: ${body}`)
    }
    const ordersData = await ordersRes.json() as { orders: { total_price: string }[] }
    const totalRevenue = ordersData.orders.reduce((sum, o) => sum + Number(o.total_price ?? 0), 0)
    const dailyAvgRevenue = Math.round((totalRevenue / 30) * 100) / 100

    // Visitors not available via Admin API - mark explicitly so the dashboard
    // shows "n/a" with the right tooltip instead of a misleading "0".
    clearError(prefix)
    return [
      { key: `${prefix}-orders`,   value: ordersToday },
      { key: `${prefix}-revenue`,  value: dailyAvgRevenue },
      unavailableEntry(prefix, 'visitors', 'Visitor count requires Shopify Storefront Analytics API'),
    ]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    noteError(prefix, msg)
    logger.error({ err, prefix }, 'collectShopify failed')
    return []
  }
}

async function collectGitHub(handle: string | null, prefix: string, token?: string | null): Promise<MetricEntry[]> {
  // handle is expected in "owner/repo" form (see the integration's `handle` column)
  if (!handle || !handle.includes('/')) {
    return [
      unavailableEntry(prefix, 'stars',  'GitHub handle must be owner/repo'),
      unavailableEntry(prefix, 'forks',  'GitHub handle must be owner/repo'),
      unavailableEntry(prefix, 'issues', 'GitHub handle must be owner/repo'),
    ]
  }
  try {
    const headers: Record<string, string> = {
      'Accept':     'application/vnd.github+json',
      'User-Agent': 'ClaudePaw-MetricsCollector',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    const url = `https://api.github.com/repos/${handle}`
    const res = await quotaFetch('github', url, { headers, endpoint: '/repos/:owner/:repo' })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200)
      throw new Error(`GitHub API ${res.status}: ${body}`)
    }
    const data = await res.json() as {
      stargazers_count?: number
      forks_count?: number
      open_issues_count?: number
    }
    clearError(prefix)
    return [
      { key: `${prefix}-stars`,  value: data.stargazers_count   ?? 0 },
      { key: `${prefix}-forks`,  value: data.forks_count        ?? 0 },
      { key: `${prefix}-issues`, value: data.open_issues_count  ?? 0 },
    ]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    noteError(prefix, msg)
    logger.error({ err, prefix }, 'collectGitHub failed')
    return []
  }
}

/** Lightweight website "is alive" check used when GA credentials are not available. */
async function collectWebsiteStatus(handle: string | null, prefix: string): Promise<MetricEntry[]> {
  const reason = 'No Google Analytics credentials configured'
  if (!handle) {
    return [
      unavailableEntry(prefix, 'sessions', reason),
      unavailableEntry(prefix, 'users',    reason),
      unavailableEntry(prefix, 'bounce',   reason),
    ]
  }
  // Try a HEAD request just to confirm the site responds; values stay placeholder.
  try {
    const url = handle.startsWith('http') ? handle : `https://${handle}`
    const res = await fetchWithTimeout(url, { method: 'HEAD' })
    const aliveReason = res.ok
      ? 'Site reachable - GA not configured'
      : `Site responded ${res.status} - GA not configured`
    return [
      unavailableEntry(prefix, 'sessions', aliveReason),
      unavailableEntry(prefix, 'users',    aliveReason),
      unavailableEntry(prefix, 'bounce',   aliveReason),
    ]
  } catch {
    return [
      unavailableEntry(prefix, 'sessions', 'Site unreachable - GA not configured'),
      unavailableEntry(prefix, 'users',    'Site unreachable - GA not configured'),
      unavailableEntry(prefix, 'bounce',   'Site unreachable - GA not configured'),
    ]
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runMetricsCollection(): Promise<string> {
  const botDb = getBotDb()
  if (!botDb) return 'Failed: bot DB not available'

  const integrations = getAllProjectIntegrations()
  const results: string[] = []

  // Cache results per (platform, prefix) so two projects pointing at the same
  // account (e.g. default + default both using the @your_channel
  // YouTube channel) only burn one API call but BOTH get their metrics
  // recorded under their own project_id. Old code silently dropped the second
  // project entirely.
  const apiCache = new Map<string, MetricEntry[]>()

  for (const integ of integrations) {
    if (!integ.enabled) continue

    const prefix = integ.metric_prefix || integ.platform
    const cacheKey = `${integ.platform}:${prefix}`
    const pid = integ.project_id
    let entries: MetricEntry[] = []
    let healthReason: string | null = null

    try {
      // Reuse the API response from a previous project on the same tick if
      // another project targets the same (platform, prefix). Prevents
      // double-billing the YouTube/Twitter quota when two projects share an
      // account (e.g. "default" + "default" both pointing at the
      // @your_channel YouTube channel). Write-only before — now read first.
      const cached = apiCache.get(cacheKey)
      if (cached && cached.length > 0) {
        entries = cached
      }
      if (entries.length === 0) {
        switch (integ.platform) {
          case 'youtube': {
            const apiKey = getCredential(botDb, pid, 'youtube', 'api_key')
              ?? getCredential(botDb, pid, 'custom', 'youtube_api_key')
              ?? getCredential(botDb, pid, 'custom', 'yt_api_key')
              ?? process.env.YT_API_KEY ?? process.env.YOUTUBE_API_KEY ?? null
            const channelId = getCredential(botDb, pid, 'youtube', 'channel_id')
              ?? getCredential(botDb, pid, 'custom', 'youtube_channel_id')
              ?? process.env.YOUTUBE_CHANNEL_ID ?? null
            if (apiKey && channelId) {
              entries = await collectYouTube(apiKey, channelId, prefix)
            } else {
              healthReason = 'missing youtube api_key or channel_id'
            }
            break
          }

          case 'x-twitter': {
            const apiKey = getCredential(botDb, pid, 'twitter', 'api_key')
              ?? getCredential(botDb, pid, 'custom', 'x_api_key')
              ?? process.env.TWITTER_API_KEY ?? null
            const apiSecret = getCredential(botDb, pid, 'twitter', 'api_secret')
              ?? getCredential(botDb, pid, 'custom', 'x_api_key_secret')
              ?? process.env.TWITTER_API_SECRET ?? null
            const accessToken = getCredential(botDb, pid, 'twitter', 'access_token')
              ?? getCredential(botDb, pid, 'custom', 'x_access_token')
              ?? process.env.TWITTER_ACCESS_TOKEN ?? null
            const accessSecret = getCredential(botDb, pid, 'twitter', 'access_secret')
              ?? getCredential(botDb, pid, 'custom', 'x_access_token_secret')
              ?? process.env.TWITTER_ACCESS_SECRET ?? null
            if (apiKey && apiSecret && accessToken && accessSecret) {
              entries = await collectTwitter(apiKey, apiSecret, accessToken, accessSecret, prefix)
            } else {
              healthReason = 'missing Twitter OAuth1 credentials'
            }
            break
          }

          case 'linkedin': {
            const accessToken = getCredential(botDb, pid, 'linkedin', 'access_token')
              ?? process.env.LINKEDIN_ACCESS_TOKEN ?? null
            if (accessToken) {
              entries = await collectLinkedIn(accessToken, prefix)
            } else {
              healthReason = 'missing LinkedIn access_token'
            }
            break
          }

          case 'meta': {
            const pageToken = getCredential(botDb, pid, 'meta', 'page_access_token')
              ?? process.env.META_PAGE_ACCESS_TOKEN ?? null
            const pageId = getCredential(botDb, pid, 'meta', 'page_id')
              ?? process.env.META_PAGE_ID ?? null
            if (pageToken && pageId) {
              entries = await collectMeta(pageToken, pageId, prefix)
            } else {
              healthReason = 'missing Meta page_access_token or page_id'
            }
            break
          }

          case 'instagram': {
            const igUserId = getCredential(botDb, pid, 'meta', 'ig_user_id')
              ?? process.env.META_IG_USER_ID ?? null
            const accessToken = getCredential(botDb, pid, 'meta', 'page_access_token')
              ?? process.env.META_PAGE_ACCESS_TOKEN ?? null
            if (igUserId && accessToken) {
              entries = await collectInstagram(igUserId, accessToken, prefix)
            } else {
              healthReason = 'missing Instagram ig_user_id or page_access_token'
            }
            break
          }

          case 'website': {
            // Credential lookup order for GA. Modern multi-account OAuth wins
            // over legacy single-service rows because:
            //   * legacy google-analytics rows often hold a stale refresh
            //     token minted years ago by an account that may no longer
            //     have access to the GA properties the user actually wants
            //     to query (e.g. property created later under a different
            //     identity that the user has since become admin on)
            //   * google:<email> services are minted via the dashboard
            //     Reconnect flow, so they reflect the user's current ACL
            //     state on every refresh
            //   * client_id is bound to the refresh_token at issuance, so
            //     when we use a google:<email> token we MUST also use the
            //     env GOOGLE_CLIENT_ID/SECRET (the OAuth client the
            //     dashboard uses), not the legacy google-analytics client
            //     pair
            let clientId: string | null = null
            let clientSecret: string | null = null
            let refreshToken: string | null = null
            const services = botDb
              .prepare("SELECT DISTINCT service FROM project_credentials WHERE project_id = ? AND service LIKE 'google:%'")
              .all(pid) as Array<{ service: string }>
            for (const { service } of services) {
              const scopes = getCredential(botDb, pid, service, 'scopes') ?? ''
              if (!scopes.includes('analytics.readonly')) continue
              const candidate = getCredential(botDb, pid, service, 'refresh_token')
              if (!candidate) continue
              refreshToken = candidate
              clientId = process.env.GOOGLE_CLIENT_ID ?? null
              clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? null
              break
            }
            // Fall back to legacy google-analytics service if no modern token
            // is available (or if env client credentials are missing).
            if (!refreshToken || !clientId || !clientSecret) {
              clientId = getCredential(botDb, pid, 'google-analytics', 'client_id')
                ?? getCredential(botDb, pid, 'custom', 'ga_client_id')
                ?? process.env.GA_CLIENT_ID
                ?? process.env.GOOGLE_CLIENT_ID ?? null
              clientSecret = getCredential(botDb, pid, 'google-analytics', 'client_secret')
                ?? getCredential(botDb, pid, 'custom', 'ga_client_secret')
                ?? process.env.GA_CLIENT_SECRET
                ?? process.env.GOOGLE_CLIENT_SECRET ?? null
              refreshToken = getCredential(botDb, pid, 'google-analytics', 'refresh_token')
                ?? getCredential(botDb, pid, 'custom', 'ga_refresh_token')
                ?? process.env.GA_REFRESH_TOKEN ?? null
            }
            const prefixClean = prefix.replace(/-/g, '_')
            const propertyId: string | null
              = getCredential(botDb, pid, 'google-analytics', `${prefixClean}_property_id`)
              ?? getCredential(botDb, pid, 'custom', `ga_${prefixClean}_property_id`)
              ?? process.env[`GA_${prefixClean.toUpperCase()}_PROPERTY_ID`]
              ?? getCredential(botDb, pid, 'custom', 'ga_fop_property_id')
            if (clientId && clientSecret && refreshToken && propertyId) {
              entries = await collectGoogleAnalytics(clientId, clientSecret, refreshToken, propertyId, prefix)
            } else {
              // No GA creds - degrade gracefully so the dashboard still shows the card
              entries = await collectWebsiteStatus(integ.handle, prefix)
              healthReason = 'Google Analytics credentials not configured'
            }
            break
          }

          case 'github': {
            const token = getCredential(botDb, pid, 'github', 'token')
              ?? getCredential(botDb, pid, 'custom', 'github_token')
              ?? process.env.GITHUB_TOKEN ?? null
            entries = await collectGitHub(integ.handle, prefix, token)
            break
          }

          case 'shopify': {
            const storeUrl = getCredential(botDb, pid, 'shopify', 'store_url')
            const accessToken = getCredential(botDb, pid, 'shopify', 'access_token')
            if (storeUrl && accessToken) {
              entries = await collectShopify(storeUrl, accessToken, prefix)
            } else {
              healthReason = 'missing Shopify store_url or access_token'
            }
            break
          }

          default:
            // Platform unknown to the collector. Mark explicitly so the healer
            // can flag it instead of silently dropping it.
            upsertMetricHealth({
              integration_id: integ.id,
              project_id:     pid,
              platform:       integ.platform,
              metric_prefix:  prefix,
              status:         'unsupported',
              reason:         `No collector implemented for platform '${integ.platform}'`,
            })
            results.push(`${prefix}: unsupported platform (${integ.platform})`)
            continue
        }

        // Cache the API response for any other project pointing at the same
        // (platform, prefix) combo.
        if (entries.length > 0) apiCache.set(cacheKey, entries)
      }

      // If a collector function recorded an error via noteError(), surface it
      // as the health reason so the dashboard shows the actual platform error.
      const collectorError = lastCollectError[prefix]
      if (collectorError && !healthReason) healthReason = collectorError

      // Pad missing expected keys with placeholder n/a entries so the dashboard
      // never displays a stale "--" value when the platform partially responded.
      const padReason = healthReason ?? 'platform did not return this metric'
      const padded = padExpected(integ.platform, prefix, entries, padReason)

      const category = integ.platform === 'youtube'
        ? 'youtube'
        : integ.platform === 'website'
          ? 'analytics'
          : 'social'

      for (const entry of padded) {
        const meta = entry.unavailable
          ? JSON.stringify({ unavailable: true, reason: entry.reason })
          : null
        recordMetric(category, entry.key, entry.value, meta, pid)
      }

      // Compute health: how many of the expected keys came back with a real value?
      // - healthy:  every expected metric has a real value
      // - degraded: collector reached the platform but some expected metrics
      //             are missing or marked unavailable (e.g. LinkedIn without
      //             Marketing API, Meta without page_read_engagement scope)
      // - failing:  collector got nothing back AT ALL (no API reach, no
      //             credentials, complete shutout)
      const expected = EXPECTED_SUFFIXES[integ.platform] ?? []
      const realKeys = new Set(padded.filter(e => !e.unavailable).map(e => e.key))
      const missing = expected.filter(s => !realKeys.has(`${prefix}-${s}`))
      const reachedPlatform = entries.length > 0   // collector function returned ANY entry
      let status: 'healthy' | 'degraded' | 'failing'
      if (missing.length === 0) status = 'healthy'
      else if (reachedPlatform) status = 'degraded'
      else status = 'failing'

      upsertMetricHealth({
        integration_id: integ.id,
        project_id:     pid,
        platform:       integ.platform,
        metric_prefix:  prefix,
        status,
        reason:         status === 'healthy' ? null : (healthReason ?? 'one or more expected metrics missing'),
        missing_keys:   missing.length > 0 ? missing.map(s => `${prefix}-${s}`) : null,
      })

      results.push(`${prefix}: ${padded.filter(e => !e.unavailable).length}/${expected.length || padded.length} ${status}`)
    } catch (err) {
      if (err instanceof QuotaCooldownError) {
        const mins = Math.ceil((err.retryAt - Date.now()) / 60000)
        logger.info({ platform: err.platform, retryInMins: mins }, 'Skipping platform in quota cooldown')
        results.push(`${prefix}: cooldown ${mins}m`)
        upsertMetricHealth({
          integration_id: integ.id,
          project_id:     pid,
          platform:       integ.platform,
          metric_prefix:  prefix,
          status:         'degraded',
          reason:         `quota cooldown ${mins}m`,
        })
        continue
      }
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ err, integration: prefix }, 'Metrics collection failed')
      results.push(`${prefix}: error - ${msg.slice(0, 100)}`)
      upsertMetricHealth({
        integration_id: integ.id,
        project_id:     pid,
        platform:       integ.platform,
        metric_prefix:  prefix,
        status:         'failing',
        reason:         msg.slice(0, 200),
      })
    }
  }

  const summary = `Metrics collected: ${results.join(', ')}`
  logger.info(summary)
  return summary
}
