import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockValuesGet = vi.fn()
const mockValuesUpdate = vi.fn()
const mockValuesAppend = vi.fn()
const mockSpreadsheetsGet = vi.fn()

vi.mock('googleapis', () => ({
  google: {
    sheets: vi.fn(() => ({
      spreadsheets: {
        values: {
          get: mockValuesGet,
          update: mockValuesUpdate,
          append: mockValuesAppend,
        },
        get: mockSpreadsheetsGet,
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

import { SheetsModule } from './sheets.js'
import { GoogleApiError } from '../errors.js'

const fakeAuth = {} as never

describe('SheetsModule', () => {
  let sheets: SheetsModule

  beforeEach(() => {
    sheets = new SheetsModule()
    vi.clearAllMocks()
  })

  describe('read', () => {
    it('returns 2D string array from spreadsheet range', async () => {
      const values = [['Name', 'Age'], ['Alice', '30'], ['Bob', '25']]
      mockValuesGet.mockResolvedValue({ data: { values } })

      const result = await sheets.read(fakeAuth, 'sheet-123', 'Sheet1!A1:B3')

      expect(result).toEqual(values)
      const call = mockValuesGet.mock.calls[0][0]
      expect(call.spreadsheetId).toBe('sheet-123')
      expect(call.range).toBe('Sheet1!A1:B3')
    })

    it('returns empty array when range has no values', async () => {
      mockValuesGet.mockResolvedValue({ data: {} })

      const result = await sheets.read(fakeAuth, 'sheet-123', 'Sheet1!A1:B3')
      expect(result).toEqual([])
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockValuesGet.mockRejectedValue({ code: 403, message: 'Forbidden' })

      await expect(sheets.read(fakeAuth, 'sheet-123', 'A1')).rejects.toThrow(GoogleApiError)
      await expect(sheets.read(fakeAuth, 'sheet-123', 'A1')).rejects.toThrow('403')
    })
  })

  describe('write', () => {
    it('calls values.update with USER_ENTERED and correct params', async () => {
      mockValuesUpdate.mockResolvedValue({ data: {} })

      const values = [['Name', 'Age'], ['Alice', '30']]
      await sheets.write(fakeAuth, 'sheet-123', 'Sheet1!A1:B2', values)

      const call = mockValuesUpdate.mock.calls[0][0]
      expect(call.spreadsheetId).toBe('sheet-123')
      expect(call.range).toBe('Sheet1!A1:B2')
      expect(call.valueInputOption).toBe('USER_ENTERED')
      expect(call.requestBody.values).toEqual(values)
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockValuesUpdate.mockRejectedValue({ code: 400, message: 'Bad Request' })

      await expect(sheets.write(fakeAuth, 'sheet-123', 'A1', [['x']])).rejects.toThrow(GoogleApiError)
    })
  })

  describe('append', () => {
    it('calls values.append with USER_ENTERED and correct params', async () => {
      mockValuesAppend.mockResolvedValue({ data: {} })

      const values = [['Charlie', '28']]
      await sheets.append(fakeAuth, 'sheet-123', 'Sheet1!A:B', values)

      const call = mockValuesAppend.mock.calls[0][0]
      expect(call.spreadsheetId).toBe('sheet-123')
      expect(call.range).toBe('Sheet1!A:B')
      expect(call.valueInputOption).toBe('USER_ENTERED')
      expect(call.requestBody.values).toEqual(values)
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockValuesAppend.mockRejectedValue({ code: 403, message: 'Forbidden' })

      await expect(sheets.append(fakeAuth, 'sheet-123', 'A1', [['x']])).rejects.toThrow(GoogleApiError)
    })
  })

  describe('metadata', () => {
    it('returns SheetMetadata with correct shape', async () => {
      mockSpreadsheetsGet.mockResolvedValue({
        data: {
          spreadsheetId: 'sheet-123',
          properties: { title: 'My Spreadsheet' },
          sheets: [
            {
              properties: {
                title: 'Sheet1',
                gridProperties: { rowCount: 1000, columnCount: 26 },
              },
            },
            {
              properties: {
                title: 'Sheet2',
                gridProperties: { rowCount: 500, columnCount: 10 },
              },
            },
          ],
        },
      })

      const result = await sheets.metadata(fakeAuth, 'sheet-123')

      expect(result).toEqual({
        spreadsheetId: 'sheet-123',
        title: 'My Spreadsheet',
        sheets: [
          { title: 'Sheet1', rowCount: 1000, columnCount: 26 },
          { title: 'Sheet2', rowCount: 500, columnCount: 10 },
        ],
      })

      const call = mockSpreadsheetsGet.mock.calls[0][0]
      expect(call.spreadsheetId).toBe('sheet-123')
    })

    it('handles sheets with missing gridProperties', async () => {
      mockSpreadsheetsGet.mockResolvedValue({
        data: {
          spreadsheetId: 'sheet-456',
          properties: { title: 'Sparse Sheet' },
          sheets: [
            { properties: { title: 'Tab1' } },
          ],
        },
      })

      const result = await sheets.metadata(fakeAuth, 'sheet-456')
      expect(result.sheets[0]).toEqual({ title: 'Tab1', rowCount: 0, columnCount: 0 })
    })

    it('wraps API errors in GoogleApiError', async () => {
      mockSpreadsheetsGet.mockRejectedValue({ code: 404, message: 'Not Found' })

      await expect(sheets.metadata(fakeAuth, 'bad-id')).rejects.toThrow(GoogleApiError)
      await expect(sheets.metadata(fakeAuth, 'bad-id')).rejects.toThrow('404')
    })
  })
})
