import Database from 'better-sqlite3'
import { logger } from '../logger.js'
import { reportFeedItem, reportMetric } from '../dashboard.js'
import {
  initSocialTables,
  setSocialDb,
  createDraft,
  getPost,
  approvePost,
  rejectPost,
  markPublished,
  markFailed,
  listDrafts,
  listPosts,
  getPostStats,
} from './db.js'
import { postTweet } from './twitter.js'
import { postLinkedIn } from './linkedin.js'
import { postFacebook, postInstagram } from './meta.js'
import { uploadToYouTube } from './youtube.js'
import { resolveTwitterConfig, resolveLinkedInConfig, resolveMetaConfig, resolveYouTubeConfig } from './resolve.js'
import { getProject } from '../db.js'
import type { DraftInput, SocialPost, Platform } from './types.js'

export function initSocial(db: Database.Database): void {
  initSocialTables(db)
  setSocialDb(db)
  logger.info('Social module initialized (credential resolution at publish time)')
}

export function draft(input: DraftInput): SocialPost {
  const post = createDraft(input)
  reportFeedItem('social', 'Draft created', `[${post.platform}] ${post.content.slice(0, 60)}`)
  reportMetric('social', 'drafts_created', 1)
  return post
}

export async function approveAndPublish(postId: string): Promise<{
  post: SocialPost
  published: boolean
  error?: string
}> {
  const post = getPost(postId)
  if (!post) {
    return { post: { id: postId } as SocialPost, published: false, error: 'Post not found' }
  }
  if (post.status !== 'draft') {
    return { post, published: false, error: `Post is ${post.status}, not draft` }
  }
  approvePost(postId)
  reportFeedItem('social', 'Post approved', `[${post.platform}] ${post.id}`)
  const result = await publish(postId)
  const updatedPost = getPost(postId)!
  return { post: updatedPost, published: result, error: updatedPost.error ?? undefined }
}

export async function publish(postId: string): Promise<boolean> {
  const post = getPost(postId)
  if (!post) {
    logger.error({ postId }, 'Cannot publish: post not found')
    return false
  }

  if (post.status !== 'approved' && post.status !== 'draft') {
    logger.error({ postId, status: post.status }, 'Cannot publish: wrong status')
    return false
  }

  if (post.status === 'draft') {
    approvePost(postId)
  }

  const projectId = post.project_id
  const projectRecord = getProject(projectId)
  const projectName = projectRecord?.display_name ?? projectId

  let result: { success: boolean; platform_post_id?: string; platform_url?: string; error?: string }

  if (post.platform === 'twitter') {
    const config = resolveTwitterConfig(projectId)
    if (!config) {
      markFailed(postId, `Twitter not configured for ${projectName}`)
      return false
    }
    result = await postTweet(post.content, config, post.media_url ?? undefined)
  } else if (post.platform === 'linkedin') {
    const config = resolveLinkedInConfig(projectId)
    if (!config) {
      markFailed(postId, `LinkedIn not configured for ${projectName}`)
      return false
    }
    result = await postLinkedIn(post.content, config, post.media_url ?? undefined)
  } else if (post.platform === 'facebook') {
    const config = resolveMetaConfig(projectId)
    if (!config) {
      markFailed(postId, `Meta not configured for ${projectName}`)
      return false
    }
    result = await postFacebook(post.content, config, {
      mediaUrl: post.media_url ?? undefined,
    })
  } else if (post.platform === 'instagram') {
    const config = resolveMetaConfig(projectId)
    if (!config) {
      markFailed(postId, `Meta not configured for ${projectName}`)
      return false
    }
    if (!post.media_url) {
      markFailed(postId, 'Instagram posts require an image URL')
      return false
    }
    result = await postInstagram(post.content, config, post.media_url)
  } else if (post.platform === 'youtube') {
    const config = resolveYouTubeConfig(projectId)
    if (!config) {
      markFailed(postId, `YouTube not configured for ${projectName}. Re-authenticate Google with YouTube scopes.`)
      return false
    }
    if (!post.media_url) {
      markFailed(postId, 'YouTube posts require a video file path in media_url')
      return false
    }
    // Parse YouTube metadata from CTA field (JSON: {title, tags, categoryId, visibility, thumbnailPath})
    let ytOpts: { title?: string; tags?: string[]; categoryId?: string; visibility?: string; thumbnailPath?: string } = {}
    if (post.cta) {
      try { ytOpts = JSON.parse(post.cta) } catch { /* cta is plain text, use as title */ ytOpts = { title: post.cta } }
    }
    result = await uploadToYouTube(post.media_url, {
      title: ytOpts.title ?? post.content.slice(0, 100),
      description: post.content,
      tags: ytOpts.tags,
      categoryId: ytOpts.categoryId ?? '28',
      visibility: (ytOpts.visibility as 'private' | 'unlisted' | 'public') ?? 'unlisted',
      thumbnailPath: ytOpts.thumbnailPath,
    }, config)
  } else {
    markFailed(postId, `Unknown platform: ${post.platform}`)
    return false
  }

  if (result.success && result.platform_post_id && result.platform_url) {
    markPublished(postId, result.platform_post_id, result.platform_url)
    reportFeedItem('social', 'Post published', `[${post.platform}] ${result.platform_url}`)
    reportMetric('social', 'posts_published', 1)
    return true
  } else {
    markFailed(postId, result.error ?? 'Unknown error')
    reportFeedItem('social', 'Post failed', `[${post.platform}] ${result.error}`)
    return false
  }
}

export function reject(postId: string): boolean {
  const ok = rejectPost(postId)
  if (ok) reportFeedItem('social', 'Post rejected', postId)
  return ok
}

export function isPlatformConfigured(projectId: string, platform: Platform): boolean {
  if (platform === 'twitter') return resolveTwitterConfig(projectId) !== null
  if (platform === 'linkedin') return resolveLinkedInConfig(projectId) !== null
  if (platform === 'facebook' || platform === 'instagram') return resolveMetaConfig(projectId) !== null
  if (platform === 'youtube') return resolveYouTubeConfig(projectId) !== null
  return false
}

// Backward-compat shims -- callers must now pass a projectId
export function isTwitterConfigured(projectId = 'default'): boolean {
  return resolveTwitterConfig(projectId) !== null
}

export function isLinkedInConfigured(projectId = 'default'): boolean {
  return resolveLinkedInConfig(projectId) !== null
}

export { getPost, listDrafts, listPosts, getPostStats }
export type { SocialPost, Platform, DraftInput }
export { publishDueSocialPosts } from './scheduler.js'
export type { PublishDueResult } from './scheduler.js'
