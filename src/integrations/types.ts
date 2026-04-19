export type AuthType = 'oauth2' | 'api_key' | 'basic_auth' | 'imap'

export interface OAuthConfig {
  authUrl: string
  tokenUrl: string
  availableScopes: string[]
  requiredScopes: string[]
}

export interface ServiceManifest {
  name: string
  displayName: string
  authType: AuthType
  oauth?: OAuthConfig
  requiredKeys: string[]
  healthCheck: (projectId: string, account?: string) => Promise<boolean>
}

export interface TokenSet {
  access_token: string
  refresh_token: string
  expiry: number
  scopes: string
  account_email: string
  status: 'connected' | 'disconnected'
  disconnected_at?: number
}

export interface IntegrationStatus {
  service: string
  account: string
  status: 'connected' | 'disconnected'
  scopes: string[]
  disconnectedAt?: number
}

export interface OAuthStartResult {
  url: string
  state: string
}

export interface OAuthCallbackResult {
  projectId: string
  service: string
  account: string
  scopes: string[]
}

export interface GmailMessage {
  id: string
  threadId: string
  from: string
  to: string
  subject: string
  snippet: string
  date: string
}

export interface GmailFullMessage extends GmailMessage {
  body: string
  htmlBody?: string
  attachments: Array<{ filename: string; mimeType: string; size: number }>
  headers: Record<string, string>
}

export interface GmailThread {
  id: string
  messages: GmailFullMessage[]
}

export interface GmailLabel {
  id: string
  name: string
  type: string
}

export interface GmailDraftSummary {
  id: string
  to: string
  subject: string
  snippet: string
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: number
  createdTime?: string
  modifiedTime?: string
  parents?: string[]
}

export interface SheetMetadata {
  spreadsheetId: string
  title: string
  sheets: Array<{ title: string; rowCount: number; columnCount: number }>
}

export interface CalendarEvent {
  id: string
  summary: string
  description?: string
  location?: string
  start: string
  end: string
  attendees?: Array<{ email: string; responseStatus: string }>
}

export interface CalendarEventInput {
  summary: string
  description?: string
  location?: string
  start: string
  end: string
  attendees?: string[]
}

export interface CalendarInfo {
  id: string
  summary: string
  primary: boolean
  timeZone: string
}
