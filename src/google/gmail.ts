import { google } from 'googleapis'
import { logger } from '../logger.js'
import { DASHBOARD_URL, DASHBOARD_API_TOKEN } from '../config.js'
import { NEWSLETTER_CONFIG } from '../newsletter/config.js'
import type { EmailMessage, SendResult } from './types.js'

// ---------------------------------------------------------------------------
// Build RFC 2822 message as base64url string
// ---------------------------------------------------------------------------

export function buildRawMessage(msg: EmailMessage): string {
  const lines = [
    `To: ${msg.to}`,
    `Subject: ${msg.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    '',
    msg.htmlBody,
  ]

  const raw = lines.join('\r\n')
  return Buffer.from(raw, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// ---------------------------------------------------------------------------
// Fetch a fresh Google access token from the dashboard integrations store.
// The dashboard owns the OAuth flow and refresh logic; the bot just asks
// for a short-lived access token when it needs to send mail.
// ---------------------------------------------------------------------------

const GOOGLE_PROJECT_ID = 'default'
const GOOGLE_ACCOUNT = NEWSLETTER_CONFIG.recipientEmail

async function fetchGoogleAccessToken(): Promise<string> {
  if (!DASHBOARD_API_TOKEN) {
    throw new Error('DASHBOARD_API_TOKEN not set -- cannot fetch Google access token')
  }
  const url =
    `${DASHBOARD_URL}/api/v1/integrations/google/access-token` +
    `?project_id=${encodeURIComponent(GOOGLE_PROJECT_ID)}` +
    `&account=${encodeURIComponent(GOOGLE_ACCOUNT)}`
  const res = await fetch(url, {
    headers: { 'x-dashboard-token': DASHBOARD_API_TOKEN },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Dashboard access-token fetch failed: ${res.status} ${res.statusText} ${body}`,
    )
  }
  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) {
    throw new Error('Dashboard returned no access_token')
  }
  return data.access_token
}

// ---------------------------------------------------------------------------
// Send email via Gmail API
// ---------------------------------------------------------------------------

export async function sendEmail(msg: EmailMessage): Promise<SendResult> {
  try {
    const accessToken = await fetchGoogleAccessToken()
    const auth = new google.auth.OAuth2()
    auth.setCredentials({ access_token: accessToken })
    const gmail = google.gmail({ version: 'v1', auth })

    const raw = buildRawMessage(msg)

    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    })

    logger.info(
      { messageId: res.data.id, to: msg.to },
      'Email sent via Gmail API',
    )
    return { success: true, messageId: res.data.id ?? undefined }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.error({ err, to: msg.to }, 'Gmail send failed')
    return { success: false, error: errMsg }
  }
}
