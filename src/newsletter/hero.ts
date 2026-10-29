import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { logger } from '../logger.js'
import { NEWSLETTER_CONFIG } from './config.js'
import type { TopicId } from './types.js'

// ---------------------------------------------------------------------------
// Theme motifs for art direction
// ---------------------------------------------------------------------------

const THEME_MOTIFS: Record<TopicId, string> = {
  identity:
    'scanning a glowing biometric fingerprint to unlock a vault door',
  supply_chain:
    'inspecting a conveyor of glowing software packages for a hidden tampered one',
  model_security:
    'shielding a holographic neural network from a swarm of corrupted data shards',
  data_governance:
    'sorting luminous data cubes into locked archive drawers',
  ai_operations:
    'monitoring a wall of live model telemetry in a server control room',
  quantum_readiness:
    'rewiring a glowing quantum processor core with new cryptographic locks',
}

// ---------------------------------------------------------------------------
// Art prompt builder
// ---------------------------------------------------------------------------

// House style: one android protagonist, the week's story as the action.
export function buildArtPrompt(themes: TopicId[], scene?: string): string {
  // A scene from the brief makes each week's image tell that week's story.
  // Without one (heuristic brief, old snapshot) fall back to the lead theme.
  const topic = scene || THEME_MOTIFS[themes[0] ?? 'identity']
  return (
    `Cyberpunk android using AI - ${topic.replace(/\.$/, '')} - ` +
    `with cyan and amber neon glow, shallow depth of field, photorealistic textures, ` +
    `Blade Runner 2049 cinematography style, grainy 35mm film stock, moody atmospheric lighting, ` +
    `dark teal and orange color grade in 16:9 aspect ratio. ` +
    `No text, no letters, no words, no signs, no logos, no watermarks.`
  )
}

// ---------------------------------------------------------------------------
// File path for today's hero
// ---------------------------------------------------------------------------

export function heroPathForDate(dateStr: string): string {
  return path.join(NEWSLETTER_CONFIG.heroDir, `hero-${dateStr}.png`)
}

// ---------------------------------------------------------------------------
// Generate hero image via Gemini API
// ---------------------------------------------------------------------------

/** Reason the caller got a fallback instead of a freshly generated hero. */
export type HeroFallbackReason =
  | 'no-api-key'
  | 'api-error'
  | 'no-image-in-response'
  | 'thrown'

export type HeroResult = {
  imagePath: string
  artDirection: string
  /** Present only when imagePath/artDirection reflect a fallback. */
  fallbackReason?: HeroFallbackReason
}

function fallback(reason: HeroFallbackReason): HeroResult {
  return {
    imagePath: getFallbackHeader(),
    artDirection: 'fallback',
    fallbackReason: reason,
  }
}

export async function generateHeroImage(
  themes: TopicId[],
  dateStr: string,
  scene?: string,
): Promise<HeroResult> {
  const imagePath = heroPathForDate(dateStr)
  const artDirection = buildArtPrompt(themes, scene)

  // Idempotent: reuse existing hero for today
  if (existsSync(imagePath)) {
    logger.info({ imagePath }, 'Reusing existing hero image')
    return { imagePath, artDirection }
  }

  // Ensure directory exists
  mkdirSync(path.dirname(imagePath), { recursive: true })

  const apiKey = NEWSLETTER_CONFIG.geminiApiKey
  if (!apiKey) {
    logger.warn('GEMINI_API_KEY not set -- using fallback header')
    return fallback('no-api-key')
  }

  const model = NEWSLETTER_CONFIG.geminiModel
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: artDirection }] }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: '16:9' },
        },
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      logger.error(
        { status: res.status, body: body.slice(0, 500) },
        'Gemini API error',
      )
      return fallback('api-error')
    }

    const data = await res.json()

    const parts = data?.candidates?.[0]?.content?.parts ?? []
    const imagePart = parts.find(
      (p: Record<string, unknown>) => p.inlineData,
    )
    if (!imagePart?.inlineData?.data) {
      logger.error('Gemini response contained no image data')
      return fallback('no-image-in-response')
    }

    const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64')
    writeFileSync(imagePath, imageBuffer)
    logger.info({ imagePath, bytes: imageBuffer.length }, 'Hero image generated')

    return { imagePath, artDirection }
  } catch (err) {
    logger.error({ err }, 'Gemini hero image generation failed')
    return fallback('thrown')
  }
}

// ---------------------------------------------------------------------------
// Fallback header
// ---------------------------------------------------------------------------

function getFallbackHeader(): string {
  const fallback = path.join(
    NEWSLETTER_CONFIG.heroDir,
    '..',
    '..',
    '..',
    'assets',
    'newsletter-header.png',
  )
  if (existsSync(fallback)) return fallback
  logger.warn({ fallback }, 'Fallback header asset missing -- no hero image at all')
  return ''
}

// ---------------------------------------------------------------------------
// Optimize image for email inline embedding
// ---------------------------------------------------------------------------

export async function optimizeForEmail(imagePath: string): Promise<string> {
  if (!imagePath || !existsSync(imagePath)) {
    return ''
  }

  try {
    const sharp = (await import('sharp')).default

    let quality = 80
    let buffer: Buffer

    buffer = await sharp(imagePath)
      .resize(1200, 675, { fit: 'cover' })
      .jpeg({ quality })
      .toBuffer()

    // Reduce quality until under max size
    while (buffer.length > NEWSLETTER_CONFIG.maxHeroBytes && quality > 20) {
      quality -= 10
      buffer = await sharp(imagePath)
        .resize(1200, 675, { fit: 'cover' })
        .jpeg({ quality })
        .toBuffer()
    }

    const base64 = buffer.toString('base64')
    logger.info({ bytes: buffer.length, quality }, 'Hero image optimized for email')
    return `data:image/jpeg;base64,${base64}`
  } catch (err) {
    logger.error({ err }, 'Image optimization failed')
    return ''
  }
}
