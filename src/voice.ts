import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  STT_URL,
  STT_MODEL,
  TTS_URL,
  TTS_VOICE,
} from './config.js'
import { logger } from './logger.js'

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Build a multipart/form-data body manually so we avoid extra deps.
 * Returns { body: Buffer, contentType: string }.
 */
function buildMultipart(
  fields: Record<string, string>,
  file: { name: string; buffer: Buffer; contentType?: string },
): { body: Buffer; contentType: string } {
  const boundary = `----FormBoundary${randomUUID().replace(/-/g, '')}`
  const CRLF = '\r\n'
  const parts: Buffer[] = []

  // Text fields
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}` +
          `${value}${CRLF}`,
      ),
    )
  }

  // File field
  const mime = file.contentType ?? 'application/octet-stream'
  parts.push(
    Buffer.from(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="${file.name}"${CRLF}` +
        `Content-Type: ${mime}${CRLF}${CRLF}`,
    ),
  )
  parts.push(file.buffer)
  parts.push(Buffer.from(CRLF))

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--${CRLF}`))

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Transcribe an audio file via the WhisperX-compatible STT server.
 *
 * Telegram sends voice notes as `.oga`; WhisperX expects `.ogg`.
 * Same codec — we just rename the extension.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  if (!STT_URL) {
    return '[Voice transcription unavailable — STT_URL not configured]'
  }

  try {
    const audioBuffer = readFileSync(filePath)

    // Rename .oga → .ogg for whisper compatibility
    let filename = basename(filePath)
    if (extname(filename).toLowerCase() === '.oga') {
      filename = filename.replace(/\.oga$/i, '.ogg')
    }

    const { body, contentType } = buildMultipart(
      { model: STT_MODEL },
      { name: filename, buffer: audioBuffer, contentType: 'audio/ogg' },
    )

    const response = await fetch(STT_URL, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(body),
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown')
      logger.error(
        { status: response.status, errText },
        'STT request failed',
      )
      return `[Transcription failed: HTTP ${response.status}]`
    }

    const data = (await response.json()) as { text?: string }
    return data.text ?? '[No transcription returned]'
  } catch (err) {
    logger.error({ err, filePath }, 'STT server unreachable or error')
    return '[Voice transcription failed — STT server unreachable]'
  }
}

/**
 * Synthesize speech from text via the Chatterbox TTS server.
 *
 * Uses the Chatterbox `/v1/tts` endpoint and returns raw WAV audio bytes.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  if (!TTS_URL) {
    throw new Error('TTS_URL not configured — cannot synthesize speech')
  }

  try {
    // Chatterbox may cold-start after idle unloads, so keep a long timeout.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90_000)

    const response = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: TTS_VOICE,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown')
      throw new Error(`TTS request failed: HTTP ${response.status} — ${errText}`)
    }

    const arrayBuf = await response.arrayBuffer()
    return Buffer.from(arrayBuf)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('TTS request failed')) {
      throw err
    }
    throw new Error(
      `TTS server unreachable at ${TTS_URL}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Check which voice capabilities are available based on config.
 */
export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return {
    stt: !!STT_URL,
    tts: !!TTS_URL,
  }
}
