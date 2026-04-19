import { statSync } from 'node:fs'
import { logger } from '../logger.js'
import type { PublishResult } from './types.js'

// ---------------------------------------------------------------------------
// YouTube Data API v3 - Video Upload
//
// Uses OAuth 2.0 with refresh_token for resumable uploads.
// Default visibility: unlisted (safe for review before publishing)
// ---------------------------------------------------------------------------

export interface YouTubeConfig {
  clientId: string
  clientSecret: string
  refreshToken: string
  channelId: string
}

export interface YouTubeUploadOptions {
  title: string
  description: string
  tags?: string[]
  categoryId?: string // default: 28 (Science & Technology)
  visibility?: 'private' | 'unlisted' | 'public'
  thumbnailPath?: string
}

// ---------------------------------------------------------------------------
// Get fresh access token from refresh token
// ---------------------------------------------------------------------------

async function getAccessToken(config: YouTubeConfig): Promise<string> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Token refresh failed: ${response.status} ${body}`)
  }

  const data = (await response.json()) as { access_token: string }
  return data.access_token
}

// ---------------------------------------------------------------------------
// Upload video file to YouTube
// ---------------------------------------------------------------------------

export async function uploadToYouTube(
  videoPath: string,
  options: YouTubeUploadOptions,
  config: YouTubeConfig,
): Promise<PublishResult> {
  try {
    // Verify file exists
    const stat = statSync(videoPath)
    if (!stat.isFile()) {
      return { success: false, error: `Not a file: ${videoPath}` }
    }

    logger.info({ videoPath, size: stat.size, title: options.title }, 'Starting YouTube upload')

    // Get fresh access token
    const accessToken = await getAccessToken(config)

    // Step 1: Initialize resumable upload
    const metadata = {
      snippet: {
        title: options.title,
        description: options.description,
        tags: options.tags ?? [],
        categoryId: options.categoryId ?? '28',
      },
      status: {
        privacyStatus: options.visibility ?? 'unlisted',
        selfDeclaredMadeForKids: false,
      },
    }

    const initResponse = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(stat.size),
          'X-Upload-Content-Type': 'video/mp4',
        },
        body: JSON.stringify(metadata),
      },
    )

    if (!initResponse.ok) {
      const body = await initResponse.text()
      logger.error({ status: initResponse.status, body }, 'YouTube upload init failed')
      return { success: false, error: `YouTube API ${initResponse.status}: ${body}` }
    }

    const uploadUrl = initResponse.headers.get('location')
    if (!uploadUrl) {
      return { success: false, error: 'No upload URL in YouTube response' }
    }

    // Step 2: Upload the video file
    const videoBlob = await readFileAsBlob(videoPath, 'video/mp4')

    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(stat.size),
      },
      body: videoBlob,
    })

    if (!uploadResponse.ok) {
      const body = await uploadResponse.text()
      logger.error({ status: uploadResponse.status, body }, 'YouTube upload failed')
      return { success: false, error: `Upload failed: ${uploadResponse.status} ${body}` }
    }

    const result = (await uploadResponse.json()) as {
      id: string
      snippet: { title: string }
      status: { privacyStatus: string; uploadStatus: string }
    }

    const videoId = result.id
    const videoUrl = `https://youtu.be/${videoId}`

    logger.info({
      videoId,
      videoUrl,
      privacy: result.status.privacyStatus,
      uploadStatus: result.status.uploadStatus,
    }, 'YouTube upload complete')

    // Step 3: Set thumbnail if provided
    if (options.thumbnailPath) {
      await setThumbnail(videoId, options.thumbnailPath, accessToken)
    }

    return {
      success: true,
      platform_post_id: videoId,
      platform_url: videoUrl,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'YouTube upload failed')
    return { success: false, error: msg }
  }
}

// ---------------------------------------------------------------------------
// Set custom thumbnail
// ---------------------------------------------------------------------------

async function setThumbnail(
  videoId: string,
  thumbnailPath: string,
  accessToken: string,
): Promise<void> {
  try {
    const stat = statSync(thumbnailPath)
    const contentType = thumbnailPath.endsWith('.png') ? 'image/png' : 'image/jpeg'
    const thumbBlob = await readFileAsBlob(thumbnailPath, contentType)

    const response = await fetch(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': contentType,
          'Content-Length': String(stat.size),
        },
        body: thumbBlob,
      },
    )

    if (!response.ok) {
      const body = await response.text()
      logger.warn({ status: response.status, body }, 'Thumbnail upload failed (non-fatal)')
    } else {
      logger.info({ videoId }, 'Thumbnail set successfully')
    }
  } catch (err) {
    logger.warn({ err, videoId }, 'Thumbnail upload failed (non-fatal)')
  }
}

// ---------------------------------------------------------------------------
// Helper: read file into Buffer (for fetch body)
// ---------------------------------------------------------------------------

async function readFileAsBlob(filePath: string, mimeType: string): Promise<Blob> {
  const { readFile } = await import('node:fs/promises')
  const buf = await readFile(filePath)
  return new Blob([buf as unknown as BlobPart], { type: mimeType })
}
