import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import path from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

// ── Constants ──────────────────────────────────────────────────────────

/** Directory for downloaded media files */
export const UPLOADS_DIR: string = path.join(
  PROJECT_ROOT,
  'workspace',
  'uploads',
)

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

// ── Helpers ────────────────────────────────────────────────────────────

/** Ensure the uploads directory tree exists */
function ensureUploadsDir(): void {
  mkdirSync(UPLOADS_DIR, { recursive: true })
}

/** Keep only safe filename characters */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-')
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Download a file from Telegram's servers.
 *
 * 1. GET /getFile to resolve file_path
 * 2. Download the raw bytes
 * 3. Save to UPLOADS_DIR with a timestamped name
 * 4. Return the local path
 */
export async function downloadMedia(
  botToken: string,
  fileId: string,
  originalFilename?: string,
): Promise<string> {
  ensureUploadsDir()

  // Step 1 — resolve the file path on Telegram's servers
  const fileInfoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
  const infoResp = await fetch(fileInfoUrl)
  if (!infoResp.ok) {
    throw new Error(
      `Telegram getFile failed: HTTP ${infoResp.status}`,
    )
  }

  const infoData = (await infoResp.json()) as {
    ok: boolean
    result?: { file_path?: string }
  }
  const filePath = infoData.result?.file_path
  if (!filePath) {
    throw new Error('Telegram getFile returned no file_path')
  }

  // Step 2 — download the actual file bytes
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`
  const fileResp = await fetch(downloadUrl)
  if (!fileResp.ok) {
    throw new Error(
      `Telegram file download failed: HTTP ${fileResp.status}`,
    )
  }

  const arrayBuf = await fileResp.arrayBuffer()
  const buffer = Buffer.from(arrayBuf)

  // Step 3 — build a safe local filename
  const baseName =
    originalFilename ?? path.basename(filePath)
  const sanitized = sanitizeFilename(baseName)
  const localName = `${Date.now()}_${sanitized}`
  const localPath = path.join(UPLOADS_DIR, localName)

  // Step 4 — write to disk
  writeFileSync(localPath, buffer)
  logger.info({ localPath, size: buffer.length }, 'Media downloaded')

  return localPath
}

/**
 * Build a prompt fragment asking Claude to analyze an image.
 */
export function buildPhotoMessage(
  localPath: string,
  caption?: string,
): string {
  const base = `[Photo received] Please analyze the image at: ${localPath}`
  return caption ? `${base}\nCaption: ${caption}` : base
}

/**
 * Build a prompt fragment asking Claude to read/analyze a document.
 */
export function buildDocumentMessage(
  localPath: string,
  filename: string,
  caption?: string,
): string {
  const base = `[Document received: ${filename}] Please read and analyze the file at: ${localPath}`
  return caption ? `${base}\nCaption: ${caption}` : base
}

/**
 * Build a prompt fragment asking Claude to analyze a video.
 */
export function buildVideoMessage(
  localPath: string,
  caption?: string,
): string {
  const base = `[Video received] Please analyze the video at: ${localPath}`
  return caption ? `${base}\nCaption: ${caption}` : base
}

/**
 * Delete uploaded files older than maxAgeMs.
 *
 * Called on startup and can be called periodically.
 * Creates UPLOADS_DIR if it doesn't exist.
 */
export function cleanupOldUploads(maxAgeMs: number = DEFAULT_MAX_AGE_MS): void {
  ensureUploadsDir()

  const now = Date.now()
  let removed = 0

  try {
    const entries = readdirSync(UPLOADS_DIR)
    for (const entry of entries) {
      const fullPath = path.join(UPLOADS_DIR, entry)
      try {
        const stat = statSync(fullPath)
        if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
          unlinkSync(fullPath)
          removed++
        }
      } catch {
        // Skip files we can't stat or remove
      }
    }
  } catch {
    // Directory may not exist yet — ensureUploadsDir already handles creation
  }

  if (removed > 0) {
    logger.info({ removed }, 'Cleaned up old uploads')
  }
}
