import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock googleapis before importing the module under test
const mockFilesList = vi.fn()
const mockFilesGet = vi.fn()
const mockFilesCreate = vi.fn()
const mockFilesUpdate = vi.fn()

vi.mock('googleapis', () => ({
  google: {
    drive: vi.fn(() => ({
      files: {
        list: mockFilesList,
        get: mockFilesGet,
        create: mockFilesCreate,
        update: mockFilesUpdate,
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

// Mock fs and fs/promises
vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(() => ({
    on: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  })),
  createReadStream: vi.fn(() => ({
    pipe: vi.fn(),
  })),
}))

vi.mock('node:fs/promises', () => ({
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
}))

import { DriveModule } from './drive.js'
import { GoogleApiError } from '../errors.js'

const fakeAuth = {} as never

function makeFileRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-123',
    name: 'test.txt',
    mimeType: 'text/plain',
    size: '4096',
    createdTime: '2024-01-01T00:00:00.000Z',
    modifiedTime: '2024-06-01T00:00:00.000Z',
    parents: ['parent-folder-id'],
    ...overrides,
  }
}

function makeExpectedFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-123',
    name: 'test.txt',
    mimeType: 'text/plain',
    size: 4096,
    createdTime: '2024-01-01T00:00:00.000Z',
    modifiedTime: '2024-06-01T00:00:00.000Z',
    parents: ['parent-folder-id'],
    ...overrides,
  }
}

describe('DriveModule', () => {
  let drive: DriveModule

  beforeEach(() => {
    drive = new DriveModule()
    vi.clearAllMocks()
  })

  describe('list', () => {
    it('returns DriveFile array ordered by modifiedTime desc', async () => {
      const raw1 = makeFileRaw({ id: 'f1', name: 'newer.txt', modifiedTime: '2024-06-01T00:00:00.000Z' })
      const raw2 = makeFileRaw({ id: 'f2', name: 'older.txt', modifiedTime: '2024-01-01T00:00:00.000Z' })
      mockFilesList.mockResolvedValue({ data: { files: [raw1, raw2] } })

      const results = await drive.list(fakeAuth)

      expect(results).toHaveLength(2)
      expect(results[0]).toEqual(makeExpectedFile({ id: 'f1', name: 'newer.txt', modifiedTime: '2024-06-01T00:00:00.000Z' }))
      expect(results[1].id).toBe('f2')

      const call = mockFilesList.mock.calls[0][0]
      expect(call.q).toContain('trashed=false')
      expect(call.orderBy).toBe('modifiedTime desc')
    })

    it('applies parentId filter', async () => {
      mockFilesList.mockResolvedValue({ data: { files: [] } })

      await drive.list(fakeAuth, { parentId: 'folder-abc' })

      const call = mockFilesList.mock.calls[0][0]
      expect(call.q).toContain("'folder-abc' in parents")
    })

    it('applies mimeType filter', async () => {
      mockFilesList.mockResolvedValue({ data: { files: [] } })

      await drive.list(fakeAuth, { mimeType: 'application/pdf' })

      const call = mockFilesList.mock.calls[0][0]
      expect(call.q).toContain("mimeType='application/pdf'")
    })

    it('applies maxResults option', async () => {
      mockFilesList.mockResolvedValue({ data: { files: [] } })

      await drive.list(fakeAuth, { maxResults: 10 })

      const call = mockFilesList.mock.calls[0][0]
      expect(call.pageSize).toBe(10)
    })

    it('returns empty array when no files', async () => {
      mockFilesList.mockResolvedValue({ data: { files: [] } })

      const results = await drive.list(fakeAuth)
      expect(results).toEqual([])
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockFilesList.mockRejectedValue({ code: 403, message: 'Forbidden' })

      await expect(drive.list(fakeAuth)).rejects.toThrow(GoogleApiError)
      await expect(drive.list(fakeAuth)).rejects.toThrow('403')
    })

    it('handles files without optional fields', async () => {
      mockFilesList.mockResolvedValue({
        data: { files: [{ id: 'f1', name: 'bare.txt', mimeType: 'text/plain' }] },
      })

      const results = await drive.list(fakeAuth)
      expect(results[0]).toEqual({
        id: 'f1',
        name: 'bare.txt',
        mimeType: 'text/plain',
        size: undefined,
        createdTime: undefined,
        modifiedTime: undefined,
        parents: undefined,
      })
    })
  })

  describe('search', () => {
    it('returns matching DriveFile array', async () => {
      const raw = makeFileRaw()
      mockFilesList.mockResolvedValue({ data: { files: [raw] } })

      const results = await drive.search(fakeAuth, 'quarterly report')

      expect(results).toHaveLength(1)
      expect(results[0]).toEqual(makeExpectedFile())

      const call = mockFilesList.mock.calls[0][0]
      expect(call.q).toContain("fullText contains 'quarterly report'")
      expect(call.q).toContain('trashed=false')
    })

    it('returns empty array when no matches', async () => {
      mockFilesList.mockResolvedValue({ data: { files: [] } })

      const results = await drive.search(fakeAuth, 'nonexistent')
      expect(results).toEqual([])
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockFilesList.mockRejectedValue({ code: 500, message: 'Internal Server Error' })

      await expect(drive.search(fakeAuth, 'query')).rejects.toThrow(GoogleApiError)
    })
  })

  describe('mkdir', () => {
    it('creates a folder and returns DriveFile', async () => {
      const raw = makeFileRaw({
        id: 'folder-new',
        name: 'My Folder',
        mimeType: 'application/vnd.google-apps.folder',
        size: null,
        parents: [],
      })
      mockFilesCreate.mockResolvedValue({ data: raw })

      const result = await drive.mkdir(fakeAuth, 'My Folder')

      expect(result.id).toBe('folder-new')
      expect(result.name).toBe('My Folder')
      expect(result.mimeType).toBe('application/vnd.google-apps.folder')

      const call = mockFilesCreate.mock.calls[0][0]
      expect(call.requestBody.name).toBe('My Folder')
      expect(call.requestBody.mimeType).toBe('application/vnd.google-apps.folder')
    })

    it('creates a folder with parentId', async () => {
      const raw = makeFileRaw({
        id: 'nested-folder',
        name: 'Nested',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['parent-id'],
      })
      mockFilesCreate.mockResolvedValue({ data: raw })

      const result = await drive.mkdir(fakeAuth, 'Nested', 'parent-id')

      const call = mockFilesCreate.mock.calls[0][0]
      expect(call.requestBody.parents).toEqual(['parent-id'])
      expect(result.parents).toEqual(['parent-id'])
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockFilesCreate.mockRejectedValue({ code: 403, message: 'Forbidden' })

      await expect(drive.mkdir(fakeAuth, 'Bad Folder')).rejects.toThrow(GoogleApiError)
    })
  })

  describe('getMetadata', () => {
    it('returns DriveFile with metadata', async () => {
      const raw = makeFileRaw()
      mockFilesGet.mockResolvedValue({ data: raw })

      const result = await drive.getMetadata(fakeAuth, 'file-123')

      expect(result).toEqual(makeExpectedFile())

      const call = mockFilesGet.mock.calls[0][0]
      expect(call.fileId).toBe('file-123')
      expect(call.fields).toBeTruthy()
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockFilesGet.mockRejectedValue({ code: 404, message: 'Not Found' })

      await expect(drive.getMetadata(fakeAuth, 'missing-id')).rejects.toThrow(GoogleApiError)
      await expect(drive.getMetadata(fakeAuth, 'missing-id')).rejects.toThrow('404')
    })
  })

  describe('delete', () => {
    it('soft-deletes by setting trashed:true', async () => {
      mockFilesUpdate.mockResolvedValue({ data: {} })

      await expect(drive.delete(fakeAuth, 'file-to-trash')).resolves.toBeUndefined()

      const call = mockFilesUpdate.mock.calls[0][0]
      expect(call.fileId).toBe('file-to-trash')
      expect(call.requestBody.trashed).toBe(true)
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockFilesUpdate.mockRejectedValue({ code: 404, message: 'Not Found' })

      await expect(drive.delete(fakeAuth, 'bad-id')).rejects.toThrow(GoogleApiError)
    })
  })
})
