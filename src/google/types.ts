export interface GoogleCredentials {
  access_token: string
  refresh_token: string
  scope: string
  token_type: string
  expiry_date: number
}

export interface InlineImage {
  /** Content-ID without angle brackets. Referenced in HTML as src="cid:<this>" */
  cid: string
  /** MIME type, e.g. "image/png" */
  contentType: string
  /** Raw image bytes */
  data: Buffer
}

export interface EmailMessage {
  to: string
  subject: string
  htmlBody: string
  /** Optional inline images. When present, the message is sent as multipart/related. */
  inlineImages?: InlineImage[]
}

export interface SendResult {
  success: boolean
  messageId?: string
  error?: string
}
