import { ImapFlow } from 'imapflow'
import type { ImapConfig, ImapMessage, ImapFullMessage, ImapFolder } from './types.js'

function formatAddress(addr: { name?: string; address?: string } | undefined): string {
  if (!addr) return ''
  if (addr.name && addr.address) return `${addr.name} <${addr.address}>`
  return addr.address ?? addr.name ?? ''
}

function formatAddressList(
  addrs: Array<{ name?: string; address?: string }> | undefined,
): string {
  if (!addrs || addrs.length === 0) return ''
  return addrs.map(formatAddress).join(', ')
}

export class ImapModule {
  private async withConnection<T>(
    config: ImapConfig,
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.tls,
      auth: { user: config.email, pass: config.password },
      logger: false,
    })

    try {
      await client.connect()
      return await fn(client)
    } finally {
      await client.logout().catch(() => {})
    }
  }

  async search(
    config: ImapConfig,
    opts: {
      folder?: string
      query?: string   // IMAP search criteria: 'ALL', 'UNSEEN', 'FROM "name"', 'SUBJECT "text"'
      max?: number
    } = {},
  ): Promise<ImapMessage[]> {
    const folder = opts.folder ?? 'INBOX'
    const max = opts.max ?? 20

    return this.withConnection(config, async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        // Parse the query string into a SearchObject for imapflow
        const searchObj = parseQueryString(opts.query ?? 'ALL')

        const uidsRaw = await client.search(searchObj, { uid: true })
        const uids = uidsRaw === false ? [] : uidsRaw
        if (uids.length === 0) return []

        // Take the last `max` UIDs (most recent)
        const slicedUids = uids.slice(-max)
        const uidRange = slicedUids.join(',')

        const messages: ImapMessage[] = []

        for await (const msg of client.fetch(uidRange, {
          uid: true,
          envelope: true,
          bodyParts: ['TEXT'],
          size: true,
        }, { uid: true })) {
          const envelope = msg.envelope
          const from = formatAddressList(envelope?.from)
          const to = formatAddressList(envelope?.to)
          const subject = envelope?.subject ?? ''
          const date = envelope?.date ? envelope.date.toISOString() : ''

          // Get snippet from TEXT body part if available
          let snippet = ''
          const textPart = msg.bodyParts?.get('TEXT')
          if (textPart) {
            snippet = textPart.toString('utf-8').slice(0, 200)
          }

          messages.push({
            uid: msg.uid,
            from,
            to,
            subject,
            date,
            snippet,
          })
        }

        // Return in reverse order (newest first)
        return messages.reverse()
      } finally {
        lock.release()
      }
    })
  }

  async read(
    config: ImapConfig,
    uid: number,
    folder = 'INBOX',
  ): Promise<ImapFullMessage> {
    return this.withConnection(config, async (client) => {
      const lock = await client.getMailboxLock(folder)
      try {
        const msg = await client.fetchOne(
          String(uid),
          {
            uid: true,
            envelope: true,
            headers: true,
            bodyStructure: true,
            bodyParts: ['TEXT', '1', '2', '1.1', '1.2'],
          },
          { uid: true },
        )

        if (!msg) {
          throw new Error(`Message UID ${uid} not found in ${folder}`)
        }

        const envelope = msg.envelope
        const from = formatAddressList(envelope?.from)
        const to = formatAddressList(envelope?.to)
        const subject = envelope?.subject ?? ''
        const date = envelope?.date ? envelope.date.toISOString() : ''

        // Parse headers
        const headersMap: Record<string, string> = {}
        if (msg.headers) {
          const headerText = msg.headers.toString('utf-8')
          for (const line of headerText.split(/\r?\n/)) {
            const colon = line.indexOf(':')
            if (colon > 0) {
              const key = line.slice(0, colon).trim()
              const val = line.slice(colon + 1).trim()
              if (key) headersMap[key] = val
            }
          }
        }

        // Extract body parts
        let plainBody = ''
        let htmlBody: string | undefined

        // Try common body part keys
        for (const [key, buf] of msg.bodyParts ?? new Map()) {
          const text = buf.toString('utf-8')
          if (key === 'TEXT' || key === '1' || key === '1.1') {
            if (!plainBody) plainBody = text
          } else if (key === '2' || key === '1.2') {
            if (!htmlBody) htmlBody = text
          }
        }

        // Fallback: TEXT part might be the full body
        if (!plainBody) {
          const textPart = msg.bodyParts?.get('TEXT')
          if (textPart) plainBody = textPart.toString('utf-8')
        }

        const snippet = plainBody.slice(0, 200)

        // Extract attachments from body structure
        const attachments = extractAttachments(msg.bodyStructure)

        return {
          uid: msg.uid,
          from,
          to,
          subject,
          date,
          snippet,
          body: plainBody,
          htmlBody,
          attachments,
          headers: headersMap,
        }
      } finally {
        lock.release()
      }
    })
  }

  async listFolders(config: ImapConfig): Promise<ImapFolder[]> {
    return this.withConnection(config, async (client) => {
      const list = await client.list({ statusQuery: { messages: true } })

      return list.map((item) => ({
        name: item.name,
        path: item.path,
        specialUse: item.specialUse,
        messageCount: item.status?.messages ?? 0,
      }))
    })
  }
}

// ---- Helpers ----

interface BodyStructureNode {
  type?: string
  disposition?: string
  dispositionParameters?: Record<string, string>
  size?: number
  childNodes?: BodyStructureNode[]
}

function extractAttachments(
  node: BodyStructureNode | undefined,
): Array<{ filename: string; mimeType: string; size: number }> {
  if (!node) return []
  const result: Array<{ filename: string; mimeType: string; size: number }> = []

  function walk(n: BodyStructureNode) {
    if (
      n.disposition === 'attachment' ||
      n.disposition === 'inline' && n.dispositionParameters?.filename
    ) {
      const filename = n.dispositionParameters?.filename ?? 'attachment'
      result.push({
        filename,
        mimeType: n.type ?? 'application/octet-stream',
        size: n.size ?? 0,
      })
    }
    for (const child of n.childNodes ?? []) {
      walk(child)
    }
  }

  walk(node)
  return result
}

/**
 * Parse a plain-text IMAP query string into an imapflow SearchObject.
 * Supports: ALL, UNSEEN, SEEN, FROM "x", SUBJECT "x", TO "x", BODY "x"
 * Falls back to `all: true` for unknown input.
 */
function parseQueryString(query: string): Record<string, unknown> {
  const upper = query.trim().toUpperCase()

  if (upper === 'ALL') return { all: true }
  if (upper === 'UNSEEN') return { seen: false }
  if (upper === 'SEEN') return { seen: true }
  if (upper === 'UNANSWERED') return { answered: false }
  if (upper === 'ANSWERED') return { answered: true }
  if (upper === 'FLAGGED') return { flagged: true }
  if (upper === 'UNFLAGGED') return { flagged: false }
  if (upper === 'DELETED') return { deleted: true }
  if (upper === 'UNDELETED') return { deleted: false }

  // FROM "value"
  const fromMatch = query.match(/^FROM\s+"(.+)"$/i)
  if (fromMatch) return { from: fromMatch[1] }

  // TO "value"
  const toMatch = query.match(/^TO\s+"(.+)"$/i)
  if (toMatch) return { to: toMatch[1] }

  // SUBJECT "value"
  const subjectMatch = query.match(/^SUBJECT\s+"(.+)"$/i)
  if (subjectMatch) return { subject: subjectMatch[1] }

  // BODY "value"
  const bodyMatch = query.match(/^BODY\s+"(.+)"$/i)
  if (bodyMatch) return { body: bodyMatch[1] }

  // TEXT "value"
  const textMatch = query.match(/^TEXT\s+"(.+)"$/i)
  if (textMatch) return { text: textMatch[1] }

  // Default: return all
  return { all: true }
}
