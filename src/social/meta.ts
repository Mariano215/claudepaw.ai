import { logger } from '../logger.js'
import type { PublishResult } from './types.js'

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
      // Photo post
      endpoint = `${API_BASE}/${pageId}/photos`
      params.set('message', text)
      params.set('url', opts.mediaUrl)
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
): Promise<PublishResult> {
  const igUserId = config.igUserId
  const accessToken = config.defaultPageToken

  try {
    // Step 1: Create media container
    const containerParams = new URLSearchParams({
      caption: text,
      image_url: imageUrl,
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
