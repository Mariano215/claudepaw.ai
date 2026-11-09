import { createHmac, randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { logger } from '../logger.js'
import type { PublishResult } from './types.js'

// ---------------------------------------------------------------------------
// Twitter/X API v2 client using OAuth 1.0a (user context)
// Requires: TWITTER_API_KEY, TWITTER_API_SECRET,
//           TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET
// ---------------------------------------------------------------------------

const API_BASE = 'https://api.twitter.com/2'
const UPLOAD_BASE = 'https://upload.twitter.com/1.1'

interface TwitterConfig {
  apiKey: string
  apiSecret: string
  accessToken: string
  accessSecret: string
}

export type { TwitterConfig }

// ---------------------------------------------------------------------------
// OAuth 1.0a signature
// ---------------------------------------------------------------------------

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function generateOAuthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): string {
  const sortedKeys = Object.keys(params).sort()
  const paramString = sortedKeys.map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&')
  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`
  return createHmac('sha1', signingKey).update(baseString).digest('base64')
}

function buildAuthHeader(method: string, url: string, cfg: TwitterConfig, extraParams: Record<string, string> = {}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: cfg.apiKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)), // OAuth1.0a requires Unix epoch seconds (RFC 5849)
    oauth_token: cfg.accessToken,
    oauth_version: '1.0',
  }

  // Combine OAuth params with any body/query params for signing
  const signingParams = { ...oauthParams, ...extraParams }

  oauthParams.oauth_signature = generateOAuthSignature(
    method,
    url,
    signingParams,
    cfg.apiSecret,
    cfg.accessSecret,
  )

  // Header only includes oauth_* params, not the extra body params
  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ')

  return `OAuth ${headerParts}`
}

// ---------------------------------------------------------------------------
// Post a tweet
// ---------------------------------------------------------------------------

export async function postTweet(text: string, config: TwitterConfig, mediaUrl?: string): Promise<PublishResult> {
  const url = `${API_BASE}/tweets`

  try {
    // If media is provided as a local file path, upload it first
    let mediaIds: string[] = []
    if (mediaUrl) {
      const isLocalFile = mediaUrl.startsWith('/') || mediaUrl.startsWith('./') || mediaUrl.startsWith('file://')
      if (isLocalFile) {
        const localPath = mediaUrl.replace(/^file:\/\//, '')
        const id = await uploadTwitterMedia(localPath, config)
        if (id) {
          mediaIds = [id]
        } else {
          logger.warn({ localPath }, 'Twitter media upload failed -- posting text-only')
        }
      } else {
        // Remote URL -- Twitter v2 doesn't fetch remote URLs as media; let URL preview do its thing
        logger.info({ mediaUrl }, 'Twitter received remote URL -- relying on link preview')
      }
    }

    const body: Record<string, unknown> = { text }
    if (mediaIds.length > 0) {
      body.media = { media_ids: mediaIds }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: buildAuthHeader('POST', url, config),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const respBody = await response.text()
      logger.error({ status: response.status, body: respBody }, 'Twitter API error')
      return { success: false, error: `Twitter API ${response.status}: ${respBody}` }
    }

    const data = (await response.json()) as { data?: { id?: string } }
    const tweetId = data.data?.id

    if (!tweetId) {
      return { success: false, error: 'No tweet ID in response' }
    }

    const tweetUrl = `https://x.com/i/status/${tweetId}`
    logger.info({ tweetId, tweetUrl, withMedia: mediaIds.length > 0 }, 'Tweet posted')

    return {
      success: true,
      platform_post_id: tweetId,
      platform_url: tweetUrl,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'Twitter post failed')
    return { success: false, error: msg }
  }
}

// ---------------------------------------------------------------------------
// Media upload helper (chunked v1.1 endpoint with OAuth 1.0a)
// Twitter v2 still requires v1.1 for media uploads. INIT/APPEND/FINALIZE
// flow handles arbitrary file sizes and avoids signing multipart bodies.
// ---------------------------------------------------------------------------

async function uploadTwitterMedia(filePath: string, config: TwitterConfig): Promise<string | null> {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) {
      logger.warn({ filePath }, 'Twitter media upload skipped -- not a file')
      return null
    }

    const ext = extname(filePath).toLowerCase()
    const mimeType =
      ext === '.png' ? 'image/png' :
      ext === '.gif' ? 'image/gif' :
      ext === '.webp' ? 'image/webp' :
      'image/jpeg'
    const totalBytes = stat.size
    const url = `${UPLOAD_BASE}/media/upload.json`

    // STEP 1: INIT
    const initParams = {
      command: 'INIT',
      total_bytes: String(totalBytes),
      media_type: mimeType,
      media_category: 'tweet_image',
    }
    const initBody = new URLSearchParams(initParams).toString()
    const initRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: buildAuthHeader('POST', url, config, initParams),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: initBody,
    })

    if (!initRes.ok) {
      const body = await initRes.text()
      logger.error({ status: initRes.status, body }, 'Twitter media INIT failed')
      return null
    }

    const initData = (await initRes.json()) as { media_id_string: string }
    const mediaId = initData.media_id_string

    // STEP 2: APPEND (single chunk for simplicity -- works for files up to ~5MB)
    const fileBuf = await readFile(filePath)
    const boundary = '----claudepaw' + randomBytes(8).toString('hex')

    // Build multipart body
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="command"\r\n\r\nAPPEND\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media_id"\r\n\r\n${mediaId}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="segment_index"\r\n\r\n0\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="media"; filename="upload"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
      'utf8'
    )
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    const multipartBody = Buffer.concat([head, fileBuf, tail])

    // For multipart uploads OAuth signs only query/header params, not the body
    const appendRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: buildAuthHeader('POST', url, config),
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody as unknown as BodyInit,
    })

    if (!appendRes.ok) {
      const body = await appendRes.text()
      logger.error({ status: appendRes.status, body }, 'Twitter media APPEND failed')
      return null
    }

    // STEP 3: FINALIZE
    const finalizeParams = { command: 'FINALIZE', media_id: mediaId }
    const finalizeRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: buildAuthHeader('POST', url, config, finalizeParams),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(finalizeParams).toString(),
    })

    if (!finalizeRes.ok) {
      const body = await finalizeRes.text()
      logger.error({ status: finalizeRes.status, body }, 'Twitter media FINALIZE failed')
      return null
    }

    logger.info({ mediaId, filePath, size: totalBytes }, 'Twitter media uploaded')
    return mediaId
  } catch (err) {
    logger.error({ err, filePath }, 'Twitter media upload error')
    return null
  }
}

// ---------------------------------------------------------------------------
// Delete a tweet (for cleanup if needed)
// ---------------------------------------------------------------------------

export async function deleteTweet(tweetId: string, config: TwitterConfig): Promise<boolean> {
  const url = `${API_BASE}/tweets/${tweetId}`

  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: buildAuthHeader('DELETE', url, config),
      },
    })
    return response.ok
  } catch {
    return false
  }
}
