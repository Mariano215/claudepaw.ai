import { google } from 'googleapis'
import { logger } from '../logger.js'
import { DASHBOARD_URL, DASHBOARD_API_TOKEN } from '../config.js'
import { NEWSLETTER_CONFIG } from '../newsletter/config.js'
import type { EmailMessage, SendResult } from './types.js'

// ---------------------------------------------------------------------------
// Build RFC 2822 message as base64url string
// ---------------------------------------------------------------------------

export function buildRawMessage(msg: EmailMessage): string {
  const raw = msg.inlineImages && msg.inlineImages.length > 0
    ? buildMultipartRelatedMessage(msg)
    : buildSimpleHtmlMessage(msg)

  return Buffer.from(raw, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function buildSimpleHtmlMessage(msg: EmailMessage): string {
  const lines = [
    `To: ${msg.to}`,
    `Subject: ${msg.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    '',
    msg.htmlBody,
  ]
  return lines.join('\r\n')
}

function buildMultipartRelatedMessage(msg: EmailMessage): string {
  // Boundary must be unique per message and not occur in any body part.
  const boundary = `=_cp_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}=`

  const parts: string[] = []

  // Outer headers
  parts.push(
    [
      `To: ${msg.to}`,
      `Subject: ${msg.subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/related; boundary="${boundary}"; type="text/html"`,
      '',
      `This is a multi-part message in MIME format.`,
      '',
    ].join('\r\n'),
  )

  // HTML part
  parts.push(
    [
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: 7bit`,
      '',
      msg.htmlBody,
      '',
    ].join('\r\n'),
  )

  // One part per inline image
  for (const img of msg.inlineImages ?? []) {
    const b64 = img.data.toString('base64')
    // Wrap base64 at 76 chars per line per RFC 2045
    const wrapped = b64.match(/.{1,76}/g)?.join('\r\n') ?? b64
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${img.contentType}`,
        `Content-Transfer-Encoding: base64`,
        `Content-ID: <${img.cid}>`,
        `Content-Disposition: inline; filename="${img.cid}"`,
        '',
        wrapped,
        '',
      ].join('\r\n'),
    )
  }

  // Closing boundary
  parts.push(`--${boundary}--`)

  return parts.join('\r\n')
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
