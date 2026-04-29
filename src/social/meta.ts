import { execSync } from 'node:child_process'
import { logger } from '../logger.js'
import type { PublishResult } from './types.js'

// ---------------------------------------------------------------------------
// GitHub CDN image proxy
//
// Used for both Instagram (HostPapa WAF blocks Meta crawlers) and Facebook
// (image size enforcement — FB cap is 10 MB).
// ---------------------------------------------------------------------------

const GH_PROXY_REPO = 'YourGitHubUser/claudepaw.ai'
const GH_PROXY_BRANCH = 'main'
const GH_PROXY_PREFIX = 'assets/ig-proxy'
const FB_MAX_BYTES = 10 * 1024 * 1024 // 10 MB

/**
 * Upload a buffer to the GitHub CDN proxy and return its raw URL.
 * Returns null on failure so callers can fall back to the original URL.
 */
async function uploadToGithubCDN(buffer: Uint8Array, filename: string, label: string): Promise<string | null> {
  try {
    const ghToken = execSync('gh auth token', { encoding: 'utf-8' }).trim()
    if (!ghToken) throw new Error('gh auth token returned empty')

    const path = `${GH_PROXY_PREFIX}/${filename}`
    const base64 = Buffer.from(buffer).toString('base64')

    // Check for existing file SHA (required for update)
    const checkResp = await fetch(
      `https://api.github.com/repos/${GH_PROXY_REPO}/contents/${path}?ref=${GH_PROXY_BRANCH}`,
      { headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json' } },
    )
    let sha: string | undefined
    if (checkResp.ok) {
      const existing = await checkResp.json() as { sha?: string }
      sha = existing.sha
    }

    const body: Record<string, string> = {
      message: `${label}: ${filename}`,
      content: base64,
      branch: GH_PROXY_BRANCH,
    }
    if (sha) body.sha = sha

    const uploadResp = await fetch(
      `https://api.github.com/repos/${GH_PROXY_REPO}/contents/${path}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    )

    if (!uploadResp.ok) {
      const err = await uploadResp.text()
      logger.warn({ path, status: uploadResp.status, err }, `${label}: GitHub upload failed`)
      return null
    }

    return `https://raw.githubusercontent.com/${GH_PROXY_REPO}/${GH_PROXY_BRANCH}/${path}`
  } catch (err) {
    logger.warn({ err, filename }, `${label}: GitHub CDN upload threw`)
    return null
  }
}

async function proxyImageForInstagram(imageUrl: string): Promise<string> {
  // Only proxy URLs that are likely hosted on blocked providers
  if (!imageUrl.includes('wp-content/uploads')) return imageUrl

  try {
    const resp = await fetch(imageUrl)
    if (!resp.ok) {
      logger.warn({ imageUrl, status: resp.status }, 'IG proxy: failed to fetch source image, using original URL')
      return imageUrl
    }
    const buffer = Buffer.from(await resp.arrayBuffer())
    const filename = imageUrl.split('/').pop() ?? `ig-${Date.now()}.jpg`
    const rawUrl = await uploadToGithubCDN(buffer, filename, 'ig-proxy')
    if (!rawUrl) return imageUrl
    logger.info({ imageUrl, rawUrl }, 'IG proxy: image proxied to GitHub CDN')
    return rawUrl
  } catch (err) {
    logger.warn({ err, imageUrl }, 'IG proxy: error during proxy, falling back to original URL')
    return imageUrl
  }
}

/**
 * Preprocess an image for Facebook:
 * - Resize to fit within the 10 MB limit using sharp (JPEG, quality 85 → 70 → scale down)
 * - Upload the result to GitHub CDN so Facebook can always fetch it
 * Returns the original URL unchanged if the image is already small enough and not from a blocked host.
 */
async function preprocessImageForFacebook(imageUrl: string): Promise<string> {
  try {
    const resp = await fetch(imageUrl)
    if (!resp.ok) {
      logger.warn({ imageUrl, status: resp.status }, 'FB preprocess: failed to fetch image, using original URL')
      return imageUrl
    }
    // Use Uint8Array → Buffer<ArrayBuffer> to satisfy sharp's strict type
    const raw = Buffer.from(new Uint8Array(await resp.arrayBuffer()))

    const needsResize = raw.byteLength > FB_MAX_BYTES
    const needsProxy = imageUrl.includes('wp-content/uploads') // same WAF concern as IG

    if (!needsResize && !needsProxy) return imageUrl

    let finalBuffer: Uint8Array = raw
    if (needsResize) {
      const { default: sharp } = await import('sharp')
      // Pass 1: JPEG at quality 85
      finalBuffer = await sharp(raw).jpeg({ quality: 85 }).toBuffer()
      // Pass 2: lower quality
      if (finalBuffer.byteLength > FB_MAX_BYTES) {
        finalBuffer = await sharp(raw).jpeg({ quality: 70 }).toBuffer()
      }
      // Pass 3: scale down to 2048px wide
      if (finalBuffer.byteLength > FB_MAX_BYTES) {
        finalBuffer = await sharp(raw)
          .resize({ width: 2048, withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toBuffer()
      }
      logger.info(
        { imageUrl, originalBytes: raw.byteLength, resizedBytes: finalBuffer.byteLength },
        'FB preprocess: resized image to fit 10 MB limit',
      )
    }

    const basename = imageUrl.split('/').pop()?.replace(/\.[^.]+$/, '') ?? `fb-${Date.now()}`
    const filename = `fb-${basename}-${Date.now()}.jpg`
    const cdnUrl = await uploadToGithubCDN(finalBuffer, filename, 'fb-proxy')
    if (!cdnUrl) return imageUrl
    logger.info({ imageUrl, cdnUrl }, 'FB preprocess: image uploaded to GitHub CDN')
    return cdnUrl
  } catch (err) {
    logger.warn({ err, imageUrl }, 'FB preprocess: error, using original URL')
    return imageUrl
  }
}

// ---------------------------------------------------------------------------
// Meta Graph API client (Facebook Pages + Instagram Business)
// API version: v22.0 (upgraded from v19.0 which is deprecated May 21 2026)
//
// Facebook: requires a Page Access Token with pages_manage_posts scope
// Instagram: requires ig_user_id + Page Access Token with instagram_content_publish scope
// ---------------------------------------------------------------------------

const API_BASE = 'https://graph.facebook.com/v22.0'

export interface MetaConfig {
  appId: string
  appSecret: string
  pages: Record<string, { pageId: string; accessToken: string }> // keyed by page name
  igUserId: string // Instagram business account ID
  defaultPageToken: string // FOP main page token
  defaultPageId: string // FOP main page ID
}

// ---------------------------------------------------------------------------
// Post text (or photo) to a Facebook Page
// ---------------------------------------------------------------------------

export async function postFacebook(
  text: string,
  config: MetaConfig,
  opts?: {
    pageId?: string
    pageToken?: string
    mediaUrl?: string
    published?: boolean
  },
): Promise<PublishResult> {
  const pageId = opts?.pageId ?? config.defaultPageId
  const pageToken = opts?.pageToken ?? config.defaultPageToken

  try {
    let endpoint: string
    const params = new URLSearchParams()

    if (opts?.mediaUrl) {
      // Photo post — preprocess image (resize if > 10 MB, proxy if needed)
      const resolvedMediaUrl = await preprocessImageForFacebook(opts.mediaUrl)
      endpoint = `${API_BASE}/${pageId}/photos`
      params.set('message', text)
      params.set('url', resolvedMediaUrl)
      if (opts.published === false) params.set('published', 'false')
    } else {
      // Text post
      endpoint = `${API_BASE}/${pageId}/feed`
      params.set('message', text)
      if (opts?.published === false) params.set('published', 'false')
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${pageToken}`,
      },
      body: params.toString(),
    })

    if (!response.ok) {
      const body = await response.text()
      logger.error({ status: response.status, body }, 'Facebook API error')
      return { success: false, error: `Facebook API ${response.status}: ${body}` }
    }

    const data = (await response.json()) as { id?: string; error?: { message?: string } }

    if (data.error) {
      logger.error({ error: data.error }, 'Facebook API returned error')
      return { success: false, error: data.error.message ?? 'Facebook API error' }
    }

    const postId = data.id
    if (!postId) {
      return { success: false, error: 'No post ID in Facebook response' }
    }

    const postUrl = `https://www.facebook.com/${postId}`
    logger.info({ postId, postUrl, pageId }, 'Facebook post published')

    return {
      success: true,
      platform_post_id: postId,
      platform_url: postUrl,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'Facebook post failed')
    return { success: false, error: msg }
  }
}

// ---------------------------------------------------------------------------
// Post photo to Instagram Business Account (two-step)
// imageUrl must be a publicly accessible URL
// ---------------------------------------------------------------------------

export async function postInstagram(
  text: string,
  config: MetaConfig,
  imageUrl: string,
  /** @internal test-only: override poll delay (ms). Default 3000. */
  _pollDelayMs = 3000,
): Promise<PublishResult> {
  const igUserId = config.igUserId
  const accessToken = config.defaultPageToken

  try {
    // Proxy WordPress-hosted images to GitHub CDN -- HostPapa WAF blocks Meta's crawler IPs
    const resolvedImageUrl = await proxyImageForInstagram(imageUrl)

    // Step 1: Create media container
    // media_type=IMAGE is required by Graph API v22.0 for image posts
    const containerParams = new URLSearchParams({
      caption: text,
      image_url: resolvedImageUrl,
      media_type: 'IMAGE',
    })

    const containerResponse = await fetch(`${API_BASE}/${igUserId}/media`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: containerParams.toString(),
    })

    if (!containerResponse.ok) {
      const body = await containerResponse.text()
      logger.error({ status: containerResponse.status, body }, 'Instagram media container error')
      return { success: false, error: `Instagram container API ${containerResponse.status}: ${body}` }
    }

    const containerData = (await containerResponse.json()) as { id?: string; error?: { message?: string } }

    if (containerData.error) {
      logger.error({ error: containerData.error }, 'Instagram container API returned error')
      return { success: false, error: containerData.error.message ?? 'Instagram container API error' }
    }

    const creationId = containerData.id
    if (!creationId) {
      return { success: false, error: 'No creation_id in Instagram container response' }
    }

    // Step 1.5: Poll container status until FINISHED.
    // IG fetches the remote image asynchronously; publish fails with
    // "Media ID is not available" (code 9007) if called too early.
    const maxPolls = 20
    let containerReady = false
    for (let i = 0; i < maxPolls; i++) {
      if (_pollDelayMs > 0) await new Promise((r) => setTimeout(r, _pollDelayMs))
      const statusResponse = await fetch(
        `${API_BASE}/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`,
      )
      if (!statusResponse.ok) {
        const body = await statusResponse.text()
        logger.warn({ attempt: i + 1, status: statusResponse.status, body }, 'IG container status check failed')
        continue
      }
      const statusJson = (await statusResponse.json()) as { status_code?: string; status?: string; error?: { message?: string } }
      if (statusJson.status_code === 'FINISHED') {
        containerReady = true
        break
      }
      if (statusJson.status_code === 'ERROR' || statusJson.status_code === 'EXPIRED') {
        return { success: false, error: `Instagram container ${statusJson.status_code}: ${statusJson.status ?? 'no details'}` }
      }
      // IN_PROGRESS or PUBLISHED - keep polling (PUBLISHED shouldn't happen here but handle gracefully)
      logger.debug({ attempt: i + 1, status_code: statusJson.status_code }, 'IG container still processing')
    }

    if (!containerReady) {
      return { success: false, error: `Instagram container did not finish within ${(maxPolls * _pollDelayMs) / 1000}s` }
    }

    // Step 2: Publish the container
    const publishParams = new URLSearchParams({
      creation_id: creationId,
    })

    const publishResponse = await fetch(`${API_BASE}/${igUserId}/media_publish`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: publishParams.toString(),
    })

    if (!publishResponse.ok) {
      const body = await publishResponse.text()
      logger.error({ status: publishResponse.status, body }, 'Instagram publish error')
      return { success: false, error: `Instagram publish API ${publishResponse.status}: ${body}` }
    }

    const publishData = (await publishResponse.json()) as { id?: string; error?: { message?: string } }

    if (publishData.error) {
      logger.error({ error: publishData.error }, 'Instagram publish API returned error')
      return { success: false, error: publishData.error.message ?? 'Instagram publish API error' }
    }

    const mediaId = publishData.id
    if (!mediaId) {
      return { success: false, error: 'No media ID in Instagram publish response' }
    }

    const mediaUrl = `https://www.instagram.com/p/${mediaId}/`
    logger.info({ mediaId, mediaUrl, igUserId }, 'Instagram post published')

    return {
      success: true,
      platform_post_id: mediaId,
      platform_url: mediaUrl,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'Instagram post failed')
    return { success: false, error: msg }
  }
}

// ---------------------------------------------------------------------------
// Delete a Meta post (Facebook or Instagram)
// ---------------------------------------------------------------------------

export async function deleteMetaPost(postId: string, accessToken: string): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/${postId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      const body = await response.text()
      logger.warn({ postId, status: response.status, body }, 'Meta delete post failed')
    } else {
      logger.info({ postId }, 'Meta post deleted')
    }
  } catch (err) {
    logger.error({ err, postId }, 'Meta delete post threw')
  }
}
