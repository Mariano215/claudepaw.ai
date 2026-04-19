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
    'biometric iris scans, digital fingerprints, glowing authentication tokens',
  supply_chain:
    'interconnected chain links, flowing data pipelines, dependency graphs',
  model_security:
    'neural network shields, adversarial pattern distortions, AI brain with armor',
  data_governance:
    'encrypted data vaults, classification labels, privacy shields',
  ai_operations:
    'MLOps dashboards, model deployment pipelines, inference engines',
  quantum_readiness:
    'quantum circuits, entangled qubits, lattice-based cryptographic structures',
}

// ---------------------------------------------------------------------------
// Art prompt builder
// ---------------------------------------------------------------------------

export function buildArtPrompt(themes: TopicId[]): string {
  const motifs = themes.map((t) => THEME_MOTIFS[t]).join(', ')
  return (
    `Create a widescreen 21:9 aspect ratio cyberpunk digital art header image. ` +
    `Style: Blade Runner 2049 inspired, dark moody atmosphere with neon accents in cyan, ` +
    `magenta, and electric blue. Abstract technology motifs: ${motifs}. ` +
    `No text, no letters, no words. Cinematic lighting with volumetric fog. ` +
    `Professional quality suitable for an email newsletter header. ` +
    `Resolution should work well at 1200x514 pixels.`
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
): Promise<HeroResult> {
  const imagePath = heroPathForDate(dateStr)
  const artDirection = buildArtPrompt(themes)

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
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
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
      .resize(1200, 514, { fit: 'cover' })
      .jpeg({ quality })
      .toBuffer()

    // Reduce quality until under max size
    while (buffer.length > NEWSLETTER_CONFIG.maxHeroBytes && quality > 20) {
      quality -= 10
      buffer = await sharp(imagePath)
        .resize(1200, 514, { fit: 'cover' })
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
