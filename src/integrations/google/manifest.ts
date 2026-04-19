import type { ServiceManifest } from '../types.js'
import { getServiceCredentials } from '../../credentials.js'
import { google } from 'googleapis'

export const GOOGLE_SCOPES = {
  GMAIL_MODIFY: 'https://www.googleapis.com/auth/gmail.modify',
  GMAIL_SEND: 'https://www.googleapis.com/auth/gmail.send',
  DRIVE: 'https://www.googleapis.com/auth/drive',
  SHEETS: 'https://www.googleapis.com/auth/spreadsheets',
  CALENDAR: 'https://www.googleapis.com/auth/calendar',
  USERINFO_EMAIL: 'https://www.googleapis.com/auth/userinfo.email',
} as const

export const googleManifest: ServiceManifest = {
  name: 'google',
  displayName: 'Google Workspace',
  authType: 'oauth2',
  oauth: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    availableScopes: Object.values(GOOGLE_SCOPES),
    requiredScopes: [
      GOOGLE_SCOPES.GMAIL_MODIFY,
      GOOGLE_SCOPES.DRIVE,
      GOOGLE_SCOPES.SHEETS,
      GOOGLE_SCOPES.CALENDAR,
      GOOGLE_SCOPES.USERINFO_EMAIL,
    ],
  },
  requiredKeys: ['access_token', 'refresh_token'],
  healthCheck: async (projectId: string, account?: string): Promise<boolean> => {
    try {
      if (!account) return false
      const serviceKey = `google:${account}`
      const creds = getServiceCredentials(projectId, serviceKey)
      if (!creds.access_token) return false

      const oauth2 = new google.auth.OAuth2()
      oauth2.setCredentials({ access_token: creds.access_token })
      const gmail = google.gmail({ version: 'v1', auth: oauth2 })
      await gmail.users.labels.list({ userId: 'me' })
      return true
    } catch {
      return false
    }
  },
}
