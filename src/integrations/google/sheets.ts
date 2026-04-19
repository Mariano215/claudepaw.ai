import { google } from 'googleapis'
import { GoogleApiError } from '../errors.js'
import type { SheetMetadata } from '../types.js'

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>

function wrapError(err: unknown, method: string): never {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code: number; message: string }
    throw new GoogleApiError(e.code, e.message, method)
  }
  throw new GoogleApiError(500, String(err), method)
}

export class SheetsModule {
  async read(auth: OAuth2Client, spreadsheetId: string, range: string): Promise<string[][]> {
    const sheets = google.sheets({ version: 'v4', auth })
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
      })
      return (res.data.values ?? []) as string[][]
    } catch (err) {
      wrapError(err, 'sheets.read')
    }
  }

  async write(
    auth: OAuth2Client,
    spreadsheetId: string,
    range: string,
    values: string[][],
  ): Promise<void> {
    const sheets = google.sheets({ version: 'v4', auth })
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      })
    } catch (err) {
      wrapError(err, 'sheets.write')
    }
  }

  async append(
    auth: OAuth2Client,
    spreadsheetId: string,
    range: string,
    values: string[][],
  ): Promise<void> {
    const sheets = google.sheets({ version: 'v4', auth })
    try {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      })
    } catch (err) {
      wrapError(err, 'sheets.append')
    }
  }

  async metadata(auth: OAuth2Client, spreadsheetId: string): Promise<SheetMetadata> {
    const sheets = google.sheets({ version: 'v4', auth })
    try {
      const res = await sheets.spreadsheets.get({ spreadsheetId })
      const data = res.data
      return {
        spreadsheetId: data.spreadsheetId ?? spreadsheetId,
        title: data.properties?.title ?? '',
        sheets: (data.sheets ?? []).map(s => ({
          title: s.properties?.title ?? '',
          rowCount: s.properties?.gridProperties?.rowCount ?? 0,
          columnCount: s.properties?.gridProperties?.columnCount ?? 0,
        })),
      }
    } catch (err) {
      wrapError(err, 'sheets.metadata')
    }
  }
}
