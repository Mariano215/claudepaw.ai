import { logger } from '../logger.js'
import { listDueApproved, getPost, markFailed } from './db.js'
import type { SocialPost } from './types.js'

export interface PublishDueResult {
  attempted: number
  published: number
  failed: number
}

type Sender = (chatId: string, text: string) => Promise<void>

/**
 * Runs on every scheduler tick. Finds approved posts whose scheduled_at
 * has passed and pushes them through the existing publish() path. On
 * failure, sends a plain-text Telegram notification to the given chatId.
 * On success, stays silent (CLAUDE.md hard rule: no parse_mode, plain text).
 */
export async function publishDueSocialPosts(
  send: Sender,
  chatId: string,
  nowMs: number = Date.now(),
): Promise<PublishDueResult> {
  const due = listDueApproved(nowMs)
  if (due.length === 0) {
    return { attempted: 0, published: 0, failed: 0 }
  }

  const { publish } = await import('./index.js')

  let published = 0
  let failed = 0

  for (const post of due) {
    if (!post.id) {
      failed += 1
      const error = 'Corrupt social post row: missing id'
      logger.error({ platform: post.platform, projectId: post.project_id, scheduledAt: post.scheduled_at }, error)
      await notifyPublishFailure(send, chatId, post, error)
      continue
    }

    // How late is this post? Warn if > 60 minutes so ops can notice.
    const lagMs = nowMs - (post.scheduled_at ?? nowMs)
    if (lagMs > 60 * 60 * 1000) {
      logger.warn(
        { postId: post.id, lagMs, platform: post.platform },
        'Social post firing more than 60 min after its scheduled_at',
      )
    }

    try {
      const ok = await publish(post.id)
      if (ok) {
        published += 1
      } else {
        failed += 1
        const updated = getPost(post.id) ?? post
        await notifyPublishFailure(send, chatId, updated, updated.error ?? 'Unknown error')
      }
    } catch (err) {
      failed += 1
      const msg = err instanceof Error ? err.message : String(err)
      markFailed(post.id, msg)
      const updated = getPost(post.id) ?? post
      await notifyPublishFailure(send, chatId, updated, msg)
      logger.error({ err, postId: post.id }, 'publishDueSocialPosts: publish threw')
    }
  }

  logger.info(
    { attempted: due.length, published, failed },
    'publishDueSocialPosts tick done',
  )

  return { attempted: due.length, published, failed }
}

async function notifyPublishFailure(
  send: Sender,
  chatId: string,
  post: SocialPost,
  error: string,
): Promise<void> {
  const platformLabel =
    post.platform === 'twitter' ? 'X (Twitter)'
    : post.platform === 'linkedin' ? 'LinkedIn'
    : post.platform
  const scheduledStr = post.scheduled_at
    ? new Date(post.scheduled_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : '(unscheduled)'
  const contentPreview = post.content.slice(0, 120).replace(/\s+/g, ' ')

  const text =
    `Social post FAILED\n` +
    `Platform: ${platformLabel}\n` +
    `Project: ${post.project_id}\n` +
    `Post ID: ${post.id}\n` +
    `Scheduled: ${scheduledStr}\n` +
    `Error: ${error.slice(0, 400)}\n` +
    `Content preview: ${contentPreview}`

  try {
    await send(chatId, text)
  } catch (err) {
    logger.warn({ err, postId: post.id }, 'notifyPublishFailure: send failed (non-fatal)')
  }
}
