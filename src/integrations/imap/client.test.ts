import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ImapConfig } from './types.js'

// --- Mock imapflow ---

const mockConnect = vi.fn()
const mockLogout = vi.fn()
const mockGetMailboxLock = vi.fn()
const mockSearch = vi.fn()
const mockFetch = vi.fn()
const mockFetchOne = vi.fn()
const mockList = vi.fn()

// Use a regular function (not arrow) so `new ImapFlow(...)` in client.ts works.
// Arrow functions can't be used as constructors and throw "is not a constructor".
vi.mock('imapflow', () => ({
  ImapFlow: vi.fn(function () {
    return {
      connect: mockConnect,
      logout: mockLogout,
      getMailboxLock: mockGetMailboxLock,
      search: mockSearch,
      fetch: mockFetch,
      fetchOne: mockFetchOne,
      list: mockList,
    }
  }),
}))

import { ImapModule } from './client.js'

const testConfig: ImapConfig = {
  host: 'mail.example.com',
  port: 993,
  email: 'user@example.com',
  password: 'secret',
  tls: true,
}

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    date: new Date('2024-01-01T00:00:00Z'),
    subject: 'Test Subject',
    from: [{ name: 'Alice', address: 'alice@example.com' }],
    to: [{ name: 'Bob', address: 'bob@example.com' }],
    ...overrides,
  }
}

function makeLock() {
  return { path: 'INBOX', release: vi.fn() }
}

// Async generator helper for client.fetch mock
async function* makeMessageGenerator(messages: unknown[]) {
  for (const msg of messages) {
    yield msg
  }
}

describe('ImapModule', () => {
  let imap: ImapModule

  beforeEach(() => {
    imap = new ImapModule()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockLogout.mockResolvedValue(undefined)
    mockGetMailboxLock.mockResolvedValue(makeLock())
  })

  describe('search', () => {
    it('returns formatted ImapMessage array', async () => {
      const textBuf = Buffer.from('Hello, this is the email body')
      mockSearch.mockResolvedValue([1, 2])
      mockFetch.mockReturnValue(
        makeMessageGenerator([
          {
            uid: 1,
            envelope: makeEnvelope({ subject: 'First message' }),
            bodyParts: new Map([['TEXT', textBuf]]),
            size: 100,
          },
          {
            uid: 2,
            envelope: makeEnvelope({ subject: 'Second message' }),
            bodyParts: new Map([['TEXT', textBuf]]),
            size: 200,
          },
        ]),
      )

      const results = await imap.search(testConfig, { query: 'ALL' })

      expect(results).toHaveLength(2)
      // Results are reversed (newest first), so uid 2 comes first
      expect(results[0].uid).toBe(2)
      expect(results[0].from).toBe('Alice <alice@example.com>')
      expect(results[0].to).toBe('Bob <bob@example.com>')
      expect(results[0].date).toBe('2024-01-01T00:00:00.000Z')
      expect(results[0].snippet).toContain('Hello')
      expect(results[1].uid).toBe(1)
    })

    it('returns empty array when no messages found', async () => {
      mockSearch.mockResolvedValue([])

      const results = await imap.search(testConfig, { query: 'UNSEEN' })
      expect(results).toEqual([])
    })

    it('respects max option', async () => {
      // Return 5 UIDs but max=2 should only fetch the last 2
      mockSearch.mockResolvedValue([1, 2, 3, 4, 5])
      mockFetch.mockReturnValue(
        makeMessageGenerator([
          {
            uid: 4,
            envelope: makeEnvelope(),
            bodyParts: new Map(),
            size: 100,
          },
          {
            uid: 5,
            envelope: makeEnvelope(),
            bodyParts: new Map(),
            size: 100,
          },
        ]),
      )

      const results = await imap.search(testConfig, { max: 2 })
      // fetch was called with range '4,5' (last 2 of [1,2,3,4,5])
      expect(mockFetch).toHaveBeenCalledWith('4,5', expect.anything(), { uid: true })
      expect(results).toHaveLength(2)
    })

    it('uses INBOX folder by default', async () => {
      mockSearch.mockResolvedValue([])
      await imap.search(testConfig)
      expect(mockGetMailboxLock).toHaveBeenCalledWith('INBOX')
    })

    it('uses custom folder when specified', async () => {
      mockSearch.mockResolvedValue([])
      await imap.search(testConfig, { folder: 'Sent' })
      expect(mockGetMailboxLock).toHaveBeenCalledWith('Sent')
    })

    it('releases mailbox lock on success', async () => {
      const lock = makeLock()
      mockGetMailboxLock.mockResolvedValue(lock)
      mockSearch.mockResolvedValue([])

      await imap.search(testConfig)
      expect(lock.release).toHaveBeenCalled()
    })

    it('releases mailbox lock on error', async () => {
      const lock = makeLock()
      mockGetMailboxLock.mockResolvedValue(lock)
      mockSearch.mockRejectedValue(new Error('IMAP error'))

      await expect(imap.search(testConfig)).rejects.toThrow('IMAP error')
      expect(lock.release).toHaveBeenCalled()
    })

    it('handles connection errors gracefully', async () => {
      mockConnect.mockRejectedValue(new Error('Connection refused'))

      await expect(imap.search(testConfig)).rejects.toThrow('Connection refused')
    })
  })

  describe('read', () => {
    it('returns ImapFullMessage with body', async () => {
      const headersBuf = Buffer.from(
        'From: alice@example.com\r\nTo: bob@example.com\r\nSubject: Test\r\n',
      )
      mockFetchOne.mockResolvedValue({
        uid: 42,
        envelope: makeEnvelope({ subject: 'Full message' }),
        headers: headersBuf,
        bodyParts: new Map([
          ['1', Buffer.from('Plain text body content')],
          ['2', Buffer.from('<p>HTML body</p>')],
        ]),
        bodyStructure: {
          type: 'multipart/alternative',
          childNodes: [],
        },
      })

      const result = await imap.read(testConfig, 42)

      expect(result.uid).toBe(42)
      expect(result.from).toBe('Alice <alice@example.com>')
      expect(result.to).toBe('Bob <bob@example.com>')
      expect(result.subject).toBe('Full message')
      expect(result.body).toBe('Plain text body content')
      expect(result.htmlBody).toBe('<p>HTML body</p>')
      expect(result.headers['From']).toBe('alice@example.com')
      expect(result.attachments).toEqual([])
    })

    it('returns ImapFullMessage with TEXT part as body fallback', async () => {
      mockFetchOne.mockResolvedValue({
        uid: 10,
        envelope: makeEnvelope(),
        headers: Buffer.from(''),
        bodyParts: new Map([['TEXT', Buffer.from('fallback body')]]),
        bodyStructure: undefined,
      })

      const result = await imap.read(testConfig, 10)
      expect(result.body).toBe('fallback body')
    })

    it('extracts attachments from body structure', async () => {
      mockFetchOne.mockResolvedValue({
        uid: 99,
        envelope: makeEnvelope(),
        headers: Buffer.from(''),
        bodyParts: new Map(),
        bodyStructure: {
          type: 'multipart/mixed',
          childNodes: [
            {
              type: 'text/plain',
              disposition: undefined,
              size: 100,
            },
            {
              type: 'application/pdf',
              disposition: 'attachment',
              dispositionParameters: { filename: 'report.pdf' },
              size: 50000,
            },
          ],
        },
      })

      const result = await imap.read(testConfig, 99)
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments[0]).toEqual({
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        size: 50000,
      })
    })

    it('throws when message not found', async () => {
      mockFetchOne.mockResolvedValue(undefined)

      await expect(imap.read(testConfig, 9999)).rejects.toThrow('not found')
    })

    it('uses custom folder', async () => {
      mockFetchOne.mockResolvedValue({
        uid: 1,
        envelope: makeEnvelope(),
        headers: Buffer.from(''),
        bodyParts: new Map(),
        bodyStructure: undefined,
      })

      await imap.read(testConfig, 1, 'Sent')
      expect(mockGetMailboxLock).toHaveBeenCalledWith('Sent')
    })

    it('handles connection errors gracefully', async () => {
      mockConnect.mockRejectedValue(new Error('TLS handshake failed'))

      await expect(imap.read(testConfig, 1)).rejects.toThrow('TLS handshake failed')
    })
  })

  describe('listFolders', () => {
    it('returns ImapFolder array', async () => {
      mockList.mockResolvedValue([
        {
          name: 'INBOX',
          path: 'INBOX',
          specialUse: '\\Inbox',
          status: { messages: 42 },
        },
        {
          name: 'Sent',
          path: 'Sent',
          specialUse: '\\Sent',
          status: { messages: 10 },
        },
        {
          name: 'Drafts',
          path: 'Drafts',
          specialUse: '\\Drafts',
          status: { messages: 3 },
        },
      ])

      const folders = await imap.listFolders(testConfig)

      expect(folders).toHaveLength(3)
      expect(folders[0]).toEqual({
        name: 'INBOX',
        path: 'INBOX',
        specialUse: '\\Inbox',
        messageCount: 42,
      })
      expect(folders[1]).toEqual({
        name: 'Sent',
        path: 'Sent',
        specialUse: '\\Sent',
        messageCount: 10,
      })
      expect(folders[2].messageCount).toBe(3)
    })

    it('returns empty array when no folders', async () => {
      mockList.mockResolvedValue([])
      const folders = await imap.listFolders(testConfig)
      expect(folders).toEqual([])
    })

    it('handles folders without status (messageCount defaults to 0)', async () => {
      mockList.mockResolvedValue([
        {
          name: 'Archive',
          path: 'Archive',
          specialUse: undefined,
          status: undefined,
        },
      ])

      const folders = await imap.listFolders(testConfig)
      expect(folders[0].messageCount).toBe(0)
    })

    it('handles connection errors gracefully', async () => {
      mockConnect.mockRejectedValue(new Error('Authentication failed'))

      await expect(imap.listFolders(testConfig)).rejects.toThrow('Authentication failed')
    })
  })
})
