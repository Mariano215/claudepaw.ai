export interface GoogleCredentials {
  access_token: string
  refresh_token: string
  scope: string
  token_type: string
  expiry_date: number
}

export interface EmailMessage {
  to: string
  subject: string
  htmlBody: string
}

export interface SendResult {
  success: boolean
  messageId?: string
  error?: string
}
