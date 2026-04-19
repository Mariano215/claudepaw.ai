export interface ImapConfig {
  host: string
  port: number
  email: string   // also the username
  password: string
  tls: boolean
}

export interface ImapMessage {
  uid: number
  from: string
  to: string
  subject: string
  date: string
  snippet: string   // first ~200 chars of body
}

export interface ImapFullMessage extends ImapMessage {
  body: string
  htmlBody?: string
  attachments: Array<{ filename: string; mimeType: string; size: number }>
  headers: Record<string, string>
}

export interface ImapFolder {
  name: string
  path: string
  specialUse?: string  // e.g. '\Inbox', '\Sent', '\Drafts'
  messageCount: number
}
