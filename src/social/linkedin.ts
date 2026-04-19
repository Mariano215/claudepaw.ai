import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { logger } from '../logger.js'
import type { PublishResult } from './types.js'

// ---------------------------------------------------------------------------
// LinkedIn API client using OAuth 2.0
// Requires: LINKEDIN_ACCESS_TOKEN, LINKEDIN_PERSON_URN
//
// The access token needs the w_member_social scope.
// Person URN format: urn:li:person:XXXXXXXXXX
// ---------------------------------------------------------------------------

const API_BASE = 'https://api.linkedin.com/v2'
const REST_BASE = 'https://api.linkedin.com/rest'
const LI_VERSION = '202506'

interface LinkedInConfig {
  accessToken: string
  personUrn: string
}

export type { LinkedInConfig }

// ---------------------------------------------------------------------------
// Image upload helper -- 3-step process per LinkedIn Images API spec:
// 1) initializeUpload to get uploadUrl + image URN
// 2) PUT binary to uploadUrl
// 3) caller references the image URN in /rest/posts content body
// ---------------------------------------------------------------------------

async function uploadLinkedInImage(filePath: string, config: LinkedInConfig): Promise<string | null> {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) {
      logger.warn({ filePath }, 'LinkedIn image upload skipped -- not a file')
      return null
    }

    // Step 1: initialize upload
    const initRes = await fetch(`${REST_BASE}/images?action=initializeUpload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': LI_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify({
        initializeUploadRequest: {
          owner: config.personUrn,
        },
      }),
    })

    if (!initRes.ok) {
      const body = await initRes.text()
      logger.error({ status: initRes.status, body }, 'LinkedIn image initializeUpload failed')
      return null
    }

    const initData = (await initRes.json()) as {
      value: { uploadUrl: string; image: string }
    }
    const { uploadUrl, image: imageUrn } = initData.value

    // Step 2: PUT the binary
    const fileBuf = await readFile(filePath)
    const blob = new Blob([fileBuf as unknown as BlobPart])

    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
      },
      body: blob,
    })

    if (!putRes.ok) {
      const body = await putRes.text()
      logger.error({ status: putRes.status, body }, 'LinkedIn image binary upload failed')
      return null
    }

    logger.info({ imageUrn, filePath, size: stat.size }, 'LinkedIn image uploaded')
    return imageUrn
  } catch (err) {
    logger.error({ err, filePath }, 'LinkedIn image upload error')
    return null
  }
}

// ---------------------------------------------------------------------------
// Create a text post (UGC Post)
// ---------------------------------------------------------------------------

export async function postLinkedIn(text: string, config: LinkedInConfig, mediaUrl?: string): Promise<PublishResult> {
  // Use the modern /rest/posts endpoint (versioned API).
  // The legacy /v2/ugcPosts endpoint now requires numeric member IDs which the
  // OIDC sub format does not provide.
  let mediaContent: Record<string, unknown> | null = null

  if (mediaUrl) {
    // If media_url is a local file path, upload it via Images API and attach as image content.
    // Otherwise treat it as a remote article URL.
    const isLocalFile = mediaUrl.startsWith('/') || mediaUrl.startsWith('./') || mediaUrl.startsWith('file://')
    if (isLocalFile) {
      const localPath = mediaUrl.replace(/^file:\/\//, '')
      const imageUrn = await uploadLinkedInImage(localPath, config)
      if (imageUrn) {
        mediaContent = {
          content: {
            media: {
              id: imageUrn,
              altText: 'ClaudePaw video thumbnail',
            },
          },
        }
      } else {
        logger.warn({ localPath }, 'LinkedIn image upload failed -- posting without image')
      }
    } else {
      mediaContent = {
        content: {
          article: {
            source: mediaUrl,
            title: '',
            description: '',
          },
        },
      }
    }
  }

  const body: Record<string, unknown> = {
    author: config.personUrn,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
    ...(mediaContent ?? {}),
  }

  try {
    const response = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': LI_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const respBody = await response.text()
      logger.error({ status: response.status, body: respBody }, 'LinkedIn API error')
      return { success: false, error: `LinkedIn API ${response.status}: ${respBody}` }
    }

    // LinkedIn returns the post URN in the x-restli-id header or response body
    const postUrn =
      response.headers.get('x-restli-id') ??
      ((await response.json()) as { id?: string }).id

    if (!postUrn) {
      return { success: false, error: 'No post ID in LinkedIn response' }
    }

    // Build shareable URL from URN
    // Format: urn:li:share:XXXXX or urn:li:ugcPost:XXXXX
    const activityId = postUrn.split(':').pop() ?? postUrn
    const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`

    logger.info({ postUrn, postUrl }, 'LinkedIn post published')

    return {
      success: true,
      platform_post_id: postUrn,
      platform_url: postUrl,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'LinkedIn post failed')
    return { success: false, error: msg }
  }
}

// ---------------------------------------------------------------------------
// Delete a post
// ---------------------------------------------------------------------------

export async function deleteLinkedInPost(postUrn: string, config: LinkedInConfig): Promise<boolean> {
  try {
    const encoded = encodeURIComponent(postUrn)
    const response = await fetch(`https://api.linkedin.com/rest/posts/${encoded}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'LinkedIn-Version': LI_VERSION,
        'X-Restli-Protocol-Version': '2.0.0',
      },
    })
    return response.ok
  } catch {
    return false
  }
}
