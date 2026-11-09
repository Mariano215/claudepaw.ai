import { google } from 'googleapis'
import { createWriteStream, createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { GoogleApiError } from '../errors.js'
import type { DriveFile } from '../types.js'

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const DRIVE_FIELDS = 'id,name,mimeType,size,createdTime,modifiedTime,parents'

function toFile(f: {
  id?: string | null
  name?: string | null
  mimeType?: string | null
  size?: string | null
  createdTime?: string | null
  modifiedTime?: string | null
  parents?: string[] | null
}): DriveFile {
  return {
    id: f.id ?? '',
    name: f.name ?? '',
    mimeType: f.mimeType ?? '',
    size: f.size != null ? Number(f.size) : undefined,
    createdTime: f.createdTime ?? undefined,
    modifiedTime: f.modifiedTime ?? undefined,
    parents: f.parents ?? undefined,
  }
}

function wrapError(err: unknown, method: string): never {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as { code: number; message: string }
    throw new GoogleApiError(e.code, e.message, method)
  }
  throw new GoogleApiError(500, String(err), method)
}

export class DriveModule {
  async list(
    auth: OAuth2Client,
    opts: { parentId?: string; maxResults?: number; mimeType?: string } = {},
  ): Promise<DriveFile[]> {
    const drive = google.drive({ version: 'v3', auth })
    try {
      const qParts = ['trashed=false']
      if (opts.parentId) qParts.push(`'${opts.parentId}' in parents`)
      if (opts.mimeType) qParts.push(`mimeType='${opts.mimeType}'`)

      const res = await drive.files.list({
        q: qParts.join(' and '),
        pageSize: opts.maxResults ?? 50,
        orderBy: 'modifiedTime desc',
        fields: `files(${DRIVE_FIELDS})`,
      })

      return (res.data.files ?? []).map(toFile)
    } catch (err) {
      wrapError(err, 'drive.list')
    }
  }

  async search(auth: OAuth2Client, query: string): Promise<DriveFile[]> {
    const drive = google.drive({ version: 'v3', auth })
    try {
      const res = await drive.files.list({
        q: `fullText contains '${query}' and trashed=false`,
        orderBy: 'modifiedTime desc',
        fields: `files(${DRIVE_FIELDS})`,
      })

      return (res.data.files ?? []).map(toFile)
    } catch (err) {
      wrapError(err, 'drive.search')
    }
  }

  async download(auth: OAuth2Client, fileId: string, destPath: string): Promise<void> {
    const drive = google.drive({ version: 'v3', auth })
    try {
      const res = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' },
      )

      await new Promise<void>((resolve, reject) => {
        const dest = createWriteStream(destPath)
        ;(res.data as NodeJS.ReadableStream).pipe(dest)
        dest.on('finish', resolve)
        dest.on('error', reject)
      })
    } catch (err) {
      wrapError(err, 'drive.download')
    }
  }

  async upload(
    auth: OAuth2Client,
    filePath: string,
    opts: { parentId?: string; name?: string; mimeType?: string } = {},
  ): Promise<DriveFile> {
    const drive = google.drive({ version: 'v3', auth })
    try {
      const info = await stat(filePath)
      const fileName = opts.name ?? filePath.split('/').pop() ?? 'upload'

      const res = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: opts.parentId ? [opts.parentId] : undefined,
          mimeType: opts.mimeType,
        },
        media: {
          mimeType: opts.mimeType ?? 'application/octet-stream',
          body: createReadStream(filePath),
        },
        fields: DRIVE_FIELDS,
      })

      void info // stat used to validate file exists before upload
      return toFile(res.data)
    } catch (err) {
      wrapError(err, 'drive.upload')
    }
  }

  async mkdir(auth: OAuth2Client, name: string, parentId?: string): Promise<DriveFile> {
    const drive = google.drive({ version: 'v3', auth })
    try {
      const res = await drive.files.create({
        requestBody: {
          name,
          mimeType: FOLDER_MIME,
          parents: parentId ? [parentId] : undefined,
        },
        fields: DRIVE_FIELDS,
      })

      return toFile(res.data)
    } catch (err) {
      wrapError(err, 'drive.mkdir')
    }
  }

  async delete(auth: OAuth2Client, fileId: string): Promise<void> {
    const drive = google.drive({ version: 'v3', auth })
    try {
      await drive.files.update({
        fileId,
        requestBody: { trashed: true },
      })
    } catch (err) {
      wrapError(err, 'drive.delete')
    }
  }

  async getMetadata(auth: OAuth2Client, fileId: string): Promise<DriveFile> {
    const drive = google.drive({ version: 'v3', auth })
    try {
      const res = await drive.files.get({
        fileId,
        fields: DRIVE_FIELDS,
      })

      return toFile(res.data)
    } catch (err) {
      wrapError(err, 'drive.getMetadata')
    }
  }
}
