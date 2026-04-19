import { getServiceCredentials } from '../credentials.js'
import type { TwitterConfig } from './twitter.js'
import type { LinkedInConfig } from './linkedin.js'
import type { MetaConfig } from './meta.js'
import type { YouTubeConfig } from './youtube.js'

export function resolveTwitterConfig(projectId: string): TwitterConfig | null {
  const creds = getServiceCredentials(projectId, 'twitter')
  if (!creds.api_key || !creds.api_secret || !creds.access_token || !creds.access_secret) return null
  return {
    apiKey: creds.api_key,
    apiSecret: creds.api_secret,
    accessToken: creds.access_token,
    accessSecret: creds.access_secret,
  }
}

export function resolveLinkedInConfig(projectId: string): LinkedInConfig | null {
  const creds = getServiceCredentials(projectId, 'linkedin')
  if (!creds.access_token || !creds.person_urn) return null
  return {
    accessToken: creds.access_token,
    personUrn: creds.person_urn,
  }
}

export function resolveMetaConfig(projectId: string): MetaConfig | null {
  const creds = getServiceCredentials(projectId, 'meta')
  if (!creds.page_access_token || !creds.page_id) return null
  return {
    appId: creds.app_id,
    appSecret: creds.app_secret,
    defaultPageId: creds.page_id,
    defaultPageToken: creds.page_access_token,
    igUserId: creds.ig_user_id,
    pages: {
      [projectId]: { pageId: creds.page_id, accessToken: creds.page_access_token },
      ...(creds.evelyn_page_id ? { 'evelyn': { pageId: creds.evelyn_page_id, accessToken: creds.evelyn_page_token } } : {}),
      ...(creds.sv_page_id ? { 'sacrum-vindictae': { pageId: creds.sv_page_id, accessToken: creds.sv_page_token } } : {}),
      ...(creds.onenight_page_id ? { 'one-night': { pageId: creds.onenight_page_id, accessToken: creds.onenight_page_token } } : {}),
    },
  }
}

export function resolveYouTubeConfig(projectId: string): YouTubeConfig | null {
  // YouTube needs Google OAuth creds (client_id/secret from 'google' service)
  // plus the refresh_token from the OAuth flow, and the channel_id from 'youtube' service
  const googleCreds = getServiceCredentials(projectId, 'google')
  const ytCreds = getServiceCredentials(projectId, 'youtube')

  // Try project-level Google creds first, fall back to default project
  const clientId = googleCreds.client_id || getServiceCredentials('default', 'google').client_id
  const clientSecret = googleCreds.client_secret || getServiceCredentials('default', 'google').client_secret

  if (!clientId || !clientSecret) return null

  // Find refresh token: check project-level google:email services, then default
  let refreshToken = ''
  // Check for OAuth tokens stored under google:email pattern
  const allCreds = getServiceCredentials(projectId, 'google:')
  if (allCreds.refresh_token) {
    refreshToken = allCreds.refresh_token
  } else {
    const defaultCreds = getServiceCredentials('default', 'google:')
    refreshToken = defaultCreds.refresh_token || ''
  }

  if (!refreshToken) return null

  const channelId = ytCreds.channel_id || ''

  return {
    clientId,
    clientSecret,
    refreshToken,
    channelId,
  }
}
