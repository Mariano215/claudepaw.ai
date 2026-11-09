import { google } from 'googleapis'
import { GoogleApiError } from '../errors.js'
import type {
  GmailMessage,
  GmailFullMessage,
  GmailThread,
  GmailLabel,
  GmailDraftSummary,
} from '../types.js'

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>

function getHeader(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  const lower = name.toLowerCase()
  return headers.find(h => h.name?.toLowerCase() === lower)?.value ?? ''
}

function decodeBase64url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8')
}

interface MimePart {
  mimeType?: string | null
  body?: { data?: string | null; attachmentId?: string | null; size?: number | null } | null
  filename?: string | null
  parts?: MimePart[] | null
  headers?: Array<{ name?: string | null; value?: string | null }> | null
}

function extractBody(payload: MimePart): { plain: string; html: string } {
  let plain = ''
  let html = ''

  function walk(part: MimePart) {
    const mime = part.mimeType ?? ''
    if (mime === 'text/plain' && part.body?.data) {
      plain += decodeBase64url(part.body.data)
    } else if (mime === 'text/html' && part.body?.data) {
      html += decodeBase64url(part.body.data)
    } else if (part.parts) {
      for (const p of part.parts) walk(p)
    }
  }

  // If top-level has body data and is text/plain or text/html, handle directly
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    plain = decodeBase64url(payload.body.data)
  } else if (payload.mimeType === 'text/html' && payload.body?.data) {
    html = decodeBase64url(payload.body.data)
  } else if (payload.parts) {
    for (const p of payload.parts) walk(p)
  }

  return { plain, html }
}

function extractAttachments(payload: MimePart): Array<{ filename: string; mimeType: string; size: number }> {
  const attachments: Array<{ filename: string; mimeType: string; size: number }> = []

  function walk(part: MimePart) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body.size ?? 0,
      })
    }
    if (part.parts) {
      for (const p of part.parts) walk(p)
    }
  }

  walk(payload)
  return attachments
}

function buildRawMime(opts: {
  to: string
  cc?: string
  bcc?: string
  subject: string
  body: string
  replyTo?: string
}): string {
  const lines: string[] = []
  lines.push(`To: ${opts.to}`)
  if (opts.cc) lines.push(`Cc: ${opts.cc}`)
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`)
  if (opts.replyTo) lines.push(`Reply-To: ${opts.replyTo}`)
  lines.push(`Subject: ${opts.subject}`)
  lines.push('MIME-Version: 1.0')
  lines.push('Content-Type: text/plain; charset=UTF-8')
  lines.push('')
  lines.push(opts.body)

  return Buffer.from(lines.join('\r\n')).toString('base64url')
}

function wrapError(err: unknown, method: string): never {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code: number; message: string }
    throw new GoogleApiError(e.code, e.message, method)
  }
  throw new GoogleApiError(500, String(err), method)
}

export class GmailModule {
  async search(
    auth: OAuth2Client,
    query: string,
    opts: { maxResults?: number; pageToken?: string } = {},
  ): Promise<GmailMessage[]> {
    const gmail = google.gmail({ version: 'v1', auth })
    try {
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: opts.maxResults ?? 20,
        pageToken: opts.pageToken,
      })

      const messages = listRes.data.messages ?? []
      if (messages.length === 0) return []

      const full = await Promise.all(
        messages.map(m =>
          gmail.users.messages.get({
            userId: 'me',
            id: m.id!,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date'],
          }),
        ),
      )

      return full.map(res => {
        const msg = res.data
        const headers = msg.payload?.headers ?? []
        return {
          id: msg.id ?? '',
          threadId: msg.threadId ?? '',
          from: getHeader(headers, 'From'),
          to: getHeader(headers, 'To'),
          subject: getHeader(headers, 'Subject'),
          snippet: msg.snippet ?? '',
          date: getHeader(headers, 'Date'),
        }
      })
    } catch (err) {
      wrapError(err, 'gmail.search')
    }
  }

  async read(auth: OAuth2Client, messageId: string): Promise<GmailFullMessage> {
    const gmail = google.gmail({ version: 'v1', auth })
    try {
      const res = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      })

      const msg = res.data
      const headers = msg.payload?.headers ?? []
      const payload = msg.payload as MimePart | undefined

      const { plain, html } = payload ? extractBody(payload) : { plain: '', html: '' }
      const attachments = payload ? extractAttachments(payload) : []

      const headersMap: Record<string, string> = {}
      for (const h of headers) {
        if (h.name && h.value) headersMap[h.name] = h.value
      }

      return {
        id: msg.id ?? '',
        threadId: msg.threadId ?? '',
        from: getHeader(headers, 'From'),
        to: getHeader(headers, 'To'),
        subject: getHeader(headers, 'Subject'),
        snippet: msg.snippet ?? '',
        date: getHeader(headers, 'Date'),
        body: plain,
        htmlBody: html || undefined,
        attachments,
        headers: headersMap,
      }
    } catch (err) {
      wrapError(err, 'gmail.read')
    }
  }

  async readThread(auth: OAuth2Client, threadId: string): Promise<GmailThread> {
    const gmail = google.gmail({ version: 'v1', auth })
    try {
      const res = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'full',
      })

      const thread = res.data
      const messages = await Promise.all(
        (thread.messages ?? []).map(m => this.read(auth, m.id!)),
      )

      return {
        id: thread.id ?? '',
        messages,
      }
    } catch (err) {
      wrapError(err, 'gmail.readThread')
    }
  }

  async createDraft(
    auth: OAuth2Client,
    opts: {
      to: string
      cc?: string
      bcc?: string
      subject: string
      body: string
      replyTo?: string
    },
  ): Promise<{ draftId: string }> {
    const gmail = google.gmail({ version: 'v1', auth })
    try {
      const raw = buildRawMime(opts)
      const res = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: { raw },
        },
      })

      return { draftId: res.data.id ?? '' }
    } catch (err) {
      wrapError(err, 'gmail.createDraft')
    }
  }

  async sendDraft(auth: OAuth2Client, draftId: string): Promise<void> {
    const gmail = google.gmail({ version: 'v1', auth })
    try {
      await gmail.users.drafts.send({
        userId: 'me',
        requestBody: { id: draftId },
      })
    } catch (err) {
      wrapError(err, 'gmail.sendDraft')
    }
  }

  async listLabels(auth: OAuth2Client): Promise<GmailLabel[]> {
    const gmail = google.gmail({ version: 'v1', auth })
    try {
      const res = await gmail.users.labels.list({ userId: 'me' })
      return (res.data.labels ?? []).map(l => ({
        id: l.id ?? '',
        name: l.name ?? '',
        type: l.type ?? '',
      }))
    } catch (err) {
      wrapError(err, 'gmail.listLabels')
    }
  }

  async listDrafts(auth: OAuth2Client): Promise<GmailDraftSummary[]> {
    const gmail = google.gmail({ version: 'v1', auth })
    try {
      const res = await gmail.users.drafts.list({ userId: 'me' })
      const drafts = res.data.drafts ?? []
      if (drafts.length === 0) return []

      const full = await Promise.all(
        drafts.map(d =>
          gmail.users.drafts.get({
            userId: 'me',
            id: d.id!,
            format: 'metadata',
          }),
        ),
      )

      return full.map(res => {
        const draft = res.data
        const headers = draft.message?.payload?.headers ?? []
        return {
          id: draft.id ?? '',
          to: getHeader(headers, 'To'),
          subject: getHeader(headers, 'Subject'),
          snippet: draft.message?.snippet ?? '',
        }
      })
    } catch (err) {
      wrapError(err, 'gmail.listDrafts')
    }
  }
}
