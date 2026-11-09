import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock googleapis before importing the module under test
const mockMessagesList = vi.fn()
const mockMessagesGet = vi.fn()
const mockThreadsGet = vi.fn()
const mockDraftsCreate = vi.fn()
const mockDraftsSend = vi.fn()
const mockDraftsGet = vi.fn()
const mockDraftsList = vi.fn()
const mockLabelsList = vi.fn()

vi.mock('googleapis', () => ({
  google: {
    gmail: vi.fn(() => ({
      users: {
        messages: {
          list: mockMessagesList,
          get: mockMessagesGet,
        },
        threads: {
          get: mockThreadsGet,
        },
        drafts: {
          create: mockDraftsCreate,
          send: mockDraftsSend,
          get: mockDraftsGet,
          list: mockDraftsList,
        },
        labels: {
          list: mockLabelsList,
        },
      },
    })),
    auth: {
      OAuth2: class {
        setCredentials() {}
        credentials = {}
      },
    },
  },
}))

import { GmailModule } from './gmail.js'
import { GoogleApiError } from '../errors.js'

// Fake auth client
const fakeAuth = {} as never

function makeMessageMeta(id: string, threadId: string) {
  return {
    data: {
      id,
      threadId,
      snippet: `snippet for ${id}`,
      payload: {
        headers: [
          { name: 'From', value: 'sender@example.com' },
          { name: 'To', value: 'recipient@example.com' },
          { name: 'Subject', value: `Subject ${id}` },
          { name: 'Date', value: 'Mon, 01 Jan 2024 00:00:00 +0000' },
        ],
      },
    },
  }
}

function makeFullMessage(id: string, threadId: string) {
  const bodyData = Buffer.from('Hello world').toString('base64url')
  const htmlData = Buffer.from('<p>Hello world</p>').toString('base64url')
  return {
    data: {
      id,
      threadId,
      snippet: `snippet for ${id}`,
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'From', value: 'sender@example.com' },
          { name: 'To', value: 'recipient@example.com' },
          { name: 'Subject', value: `Subject ${id}` },
          { name: 'Date', value: 'Mon, 01 Jan 2024 00:00:00 +0000' },
        ],
        parts: [
          {
            mimeType: 'text/plain',
            body: { data: bodyData, size: 11 },
            filename: '',
          },
          {
            mimeType: 'text/html',
            body: { data: htmlData, size: 19 },
            filename: '',
          },
        ],
      },
    },
  }
}

describe('GmailModule', () => {
  let gmail: GmailModule

  beforeEach(() => {
    gmail = new GmailModule()
    vi.clearAllMocks()
  })

  describe('search', () => {
    it('returns formatted GmailMessage array', async () => {
      mockMessagesList.mockResolvedValue({
        data: { messages: [{ id: 'msg1' }, { id: 'msg2' }] },
      })
      mockMessagesGet
        .mockResolvedValueOnce(makeMessageMeta('msg1', 'thread1'))
        .mockResolvedValueOnce(makeMessageMeta('msg2', 'thread2'))

      const results = await gmail.search(fakeAuth, 'from:example.com')

      expect(results).toHaveLength(2)
      expect(results[0]).toEqual({
        id: 'msg1',
        threadId: 'thread1',
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Subject msg1',
        snippet: 'snippet for msg1',
        date: 'Mon, 01 Jan 2024 00:00:00 +0000',
      })
      expect(results[1].id).toBe('msg2')
    })

    it('returns empty array when no messages found', async () => {
      mockMessagesList.mockResolvedValue({ data: { messages: [] } })

      const results = await gmail.search(fakeAuth, 'nothing')
      expect(results).toEqual([])
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockMessagesList.mockRejectedValue({ code: 401, message: 'Unauthorized' })

      await expect(gmail.search(fakeAuth, 'q')).rejects.toThrow(GoogleApiError)
      await expect(gmail.search(fakeAuth, 'q')).rejects.toThrow('401')
    })
  })

  describe('read', () => {
    it('returns GmailFullMessage with parsed body', async () => {
      mockMessagesGet.mockResolvedValue(makeFullMessage('msg1', 'thread1'))

      const result = await gmail.read(fakeAuth, 'msg1')

      expect(result.id).toBe('msg1')
      expect(result.threadId).toBe('thread1')
      expect(result.from).toBe('sender@example.com')
      expect(result.body).toBe('Hello world')
      expect(result.htmlBody).toBe('<p>Hello world</p>')
      expect(result.attachments).toEqual([])
      expect(result.headers['From']).toBe('sender@example.com')
    })

    it('extracts attachments from multipart messages', async () => {
      mockMessagesGet.mockResolvedValue({
        data: {
          id: 'msg-attach',
          threadId: 'thread1',
          snippet: 'has attachment',
          payload: {
            mimeType: 'multipart/mixed',
            headers: [
              { name: 'From', value: 'a@b.com' },
              { name: 'To', value: 'c@d.com' },
              { name: 'Subject', value: 'With Attachment' },
              { name: 'Date', value: 'Mon, 01 Jan 2024 00:00:00 +0000' },
            ],
            parts: [
              {
                mimeType: 'text/plain',
                body: { data: Buffer.from('body').toString('base64url'), size: 4 },
                filename: '',
              },
              {
                mimeType: 'application/pdf',
                filename: 'doc.pdf',
                body: { attachmentId: 'att123', size: 12345 },
              },
            ],
          },
        },
      })

      const result = await gmail.read(fakeAuth, 'msg-attach')
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments[0]).toEqual({
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        size: 12345,
      })
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockMessagesGet.mockRejectedValue({ code: 404, message: 'Not Found' })

      await expect(gmail.read(fakeAuth, 'bad-id')).rejects.toThrow(GoogleApiError)
    })
  })

  describe('createDraft', () => {
    it('returns draftId', async () => {
      mockDraftsCreate.mockResolvedValue({ data: { id: 'draft123' } })

      const result = await gmail.createDraft(fakeAuth, {
        to: 'someone@example.com',
        subject: 'Test Subject',
        body: 'Test body',
      })

      expect(result).toEqual({ draftId: 'draft123' })
      expect(mockDraftsCreate).toHaveBeenCalledOnce()

      const call = mockDraftsCreate.mock.calls[0][0]
      expect(call.userId).toBe('me')
      expect(call.requestBody.message.raw).toBeTruthy()

      // Verify the raw MIME decodes correctly
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('To: someone@example.com')
      expect(decoded).toContain('Subject: Test Subject')
      expect(decoded).toContain('Test body')
    })

    it('includes optional cc, bcc, replyTo in MIME', async () => {
      mockDraftsCreate.mockResolvedValue({ data: { id: 'draft456' } })

      await gmail.createDraft(fakeAuth, {
        to: 'to@example.com',
        cc: 'cc@example.com',
        bcc: 'bcc@example.com',
        subject: 'Multi recipient',
        body: 'body',
        replyTo: 'reply@example.com',
      })

      const call = mockDraftsCreate.mock.calls[0][0]
      const decoded = Buffer.from(call.requestBody.message.raw, 'base64url').toString('utf-8')
      expect(decoded).toContain('Cc: cc@example.com')
      expect(decoded).toContain('Bcc: bcc@example.com')
      expect(decoded).toContain('Reply-To: reply@example.com')
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockDraftsCreate.mockRejectedValue({ code: 403, message: 'Forbidden' })

      await expect(gmail.createDraft(fakeAuth, { to: 't@t.com', subject: 's', body: 'b' }))
        .rejects.toThrow(GoogleApiError)
    })
  })

  describe('listLabels', () => {
    it('returns GmailLabel array', async () => {
      mockLabelsList.mockResolvedValue({
        data: {
          labels: [
            { id: 'INBOX', name: 'INBOX', type: 'system' },
            { id: 'SENT', name: 'SENT', type: 'system' },
            { id: 'Label_123', name: 'My Label', type: 'user' },
          ],
        },
      })

      const labels = await gmail.listLabels(fakeAuth)

      expect(labels).toHaveLength(3)
      expect(labels[0]).toEqual({ id: 'INBOX', name: 'INBOX', type: 'system' })
      expect(labels[2]).toEqual({ id: 'Label_123', name: 'My Label', type: 'user' })
    })

    it('returns empty array when no labels', async () => {
      mockLabelsList.mockResolvedValue({ data: { labels: [] } })
      const labels = await gmail.listLabels(fakeAuth)
      expect(labels).toEqual([])
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockLabelsList.mockRejectedValue({ code: 500, message: 'Internal Error' })
      await expect(gmail.listLabels(fakeAuth)).rejects.toThrow(GoogleApiError)
    })
  })

  describe('readThread', () => {
    it('returns thread with all messages', async () => {
      mockThreadsGet.mockResolvedValue({
        data: {
          id: 'thread1',
          messages: [{ id: 'msg1' }, { id: 'msg2' }],
        },
      })
      mockMessagesGet
        .mockResolvedValueOnce(makeFullMessage('msg1', 'thread1'))
        .mockResolvedValueOnce(makeFullMessage('msg2', 'thread1'))

      const thread = await gmail.readThread(fakeAuth, 'thread1')

      expect(thread.id).toBe('thread1')
      expect(thread.messages).toHaveLength(2)
      expect(thread.messages[0].id).toBe('msg1')
      expect(thread.messages[1].id).toBe('msg2')
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockThreadsGet.mockRejectedValue({ code: 404, message: 'Not Found' })
      await expect(gmail.readThread(fakeAuth, 'bad-thread')).rejects.toThrow(GoogleApiError)
    })
  })

  describe('sendDraft', () => {
    it('sends draft without error', async () => {
      mockDraftsSend.mockResolvedValue({ data: {} })
      await expect(gmail.sendDraft(fakeAuth, 'draft123')).resolves.toBeUndefined()
      expect(mockDraftsSend).toHaveBeenCalledWith({
        userId: 'me',
        requestBody: { id: 'draft123' },
      })
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockDraftsSend.mockRejectedValue({ code: 400, message: 'Bad Request' })
      await expect(gmail.sendDraft(fakeAuth, 'bad')).rejects.toThrow(GoogleApiError)
    })
  })

  describe('listDrafts', () => {
    it('returns GmailDraftSummary array', async () => {
      mockDraftsList.mockResolvedValue({
        data: { drafts: [{ id: 'draft1' }, { id: 'draft2' }] },
      })
      mockDraftsGet
        .mockResolvedValueOnce({
          data: {
            id: 'draft1',
            message: {
              snippet: 'draft 1 snippet',
              payload: {
                headers: [
                  { name: 'To', value: 'a@b.com' },
                  { name: 'Subject', value: 'Draft One' },
                ],
              },
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            id: 'draft2',
            message: {
              snippet: 'draft 2 snippet',
              payload: {
                headers: [
                  { name: 'To', value: 'x@y.com' },
                  { name: 'Subject', value: 'Draft Two' },
                ],
              },
            },
          },
        })

      const drafts = await gmail.listDrafts(fakeAuth)

      expect(drafts).toHaveLength(2)
      expect(drafts[0]).toEqual({ id: 'draft1', to: 'a@b.com', subject: 'Draft One', snippet: 'draft 1 snippet' })
      expect(drafts[1]).toEqual({ id: 'draft2', to: 'x@y.com', subject: 'Draft Two', snippet: 'draft 2 snippet' })
    })

    it('returns empty array when no drafts', async () => {
      mockDraftsList.mockResolvedValue({ data: { drafts: [] } })
      const drafts = await gmail.listDrafts(fakeAuth)
      expect(drafts).toEqual([])
    })
  })
})
