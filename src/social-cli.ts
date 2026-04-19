#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// Social posting CLI - used by the Social agent via bash
//
// Usage:
//   tsx src/social-cli.ts draft <platform> <content> [--cta "text"] [--media "url"] [--time "morning EST"]
//   tsx src/social-cli.ts list [draft|approved|published|rejected|failed]
//   tsx src/social-cli.ts show <id>
//   tsx src/social-cli.ts approve <id>
//   tsx src/social-cli.ts reject <id>
//   tsx src/social-cli.ts stats
//   tsx src/social-cli.ts notify <id> <chat_id>   -- send draft to Telegram for approval
// ---------------------------------------------------------------------------

import { initDatabase } from './db.js'
import { initCredentialStore } from './credentials.js'
import { initSocial, draft, getPost, listDrafts, listPosts, getPostStats, approveAndPublish, reject } from './social/index.js'
import type { Platform, PostStatus } from './social/types.js'
import { BOT_TOKEN } from './config.js'

const db = initDatabase()
initCredentialStore(db)
initSocial(db)

const args = process.argv.slice(2)
const command = args[0]

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1]
      i++
    }
  }
  return flags
}

async function sendTelegramDraftNotification(postId: string, chatId: string): Promise<void> {
  const post = getPost(postId)
  if (!post) {
    console.error(`Post ${postId} not found`)
    process.exit(1)
  }

  const platformLabel = post.platform === 'twitter' ? 'X (Twitter)' : post.platform === 'youtube' ? 'YouTube' : 'LinkedIn'
  const preview = post.content.length > 280 ? post.content.slice(0, 277) + '...' : post.content

  // Plain text only -- no HTML, no markdown, no entity codes.
  let text = `${platformLabel} Draft [${post.id}]\n\n${preview}`

  if (post.platform === 'youtube') {
    // For YouTube, CTA holds JSON metadata (title, tags, visibility, etc.)
    let ytMeta: { title?: string; visibility?: string; tags?: string[] } = {}
    if (post.cta) { try { ytMeta = JSON.parse(post.cta) } catch { ytMeta = { title: post.cta } } }
    if (ytMeta.title) text += `\n\nTitle: ${ytMeta.title}`
    if (ytMeta.visibility) text += `\nVisibility: ${ytMeta.visibility}`
    if (ytMeta.tags?.length) text += `\nTags: ${ytMeta.tags.slice(0, 5).join(', ')}`
    if (post.media_url) text += `\nVideo: ${post.media_url}`
  } else {
    if (post.cta) text += `\n\nCTA: ${post.cta}`
  }
  if (post.suggested_time) text += `\nTime: ${post.suggested_time}`

  const keyboard = {
    inline_keyboard: [
      [
        { text: '\u2705 Approve & Post', callback_data: `social:approve:${post.id}` },
        { text: '\u274c Reject', callback_data: `social:reject:${post.id}` },
      ],
    ],
  }

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      // No parse_mode -- plain text only.
      reply_markup: keyboard,
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    console.error(`Telegram API error: ${body}`)
    process.exit(1)
  }

  console.log(`Draft ${postId} sent to chat ${chatId} for approval`)
}

async function main(): Promise<void> {
  switch (command) {
    case 'draft': {
      const platform = args[1] as Platform
      if (!platform || !['twitter', 'linkedin', 'youtube'].includes(platform)) {
        console.error('Usage: draft <twitter|linkedin|youtube> <content> [--cta "text|json"] [--media "path"] [--time "time"]')
        process.exit(1)
      }
      // Content is everything between platform and first flag
      const contentParts: string[] = []
      for (let i = 2; i < args.length; i++) {
        if (args[i].startsWith('--')) break
        contentParts.push(args[i])
      }
      const content = contentParts.join(' ')
      if (!content) {
        console.error('Content is required')
        process.exit(1)
      }

      const flags = parseFlags(args.slice(2))
      const post = draft({
        platform,
        content,
        cta: flags.cta,
        media_url: flags.media,
        suggested_time: flags.time,
        created_by: 'social',
        project_id: 'default',
      })
      console.log(`Draft created: ${post.id}`)
      console.log(`Platform: ${post.platform}`)
      console.log(`Content: ${post.content}`)
      if (post.cta) console.log(`CTA: ${post.cta}`)
      if (post.suggested_time) console.log(`Time: ${post.suggested_time}`)
      console.log(`\nTo send for approval: tsx src/social-cli.ts notify ${post.id} <chat_id>`)
      break
    }

    case 'list': {
      const status = args[1] as PostStatus | undefined
      const posts = status ? listPosts(status) : listPosts()
      if (posts.length === 0) {
        console.log('No posts found.')
        break
      }
      for (const p of posts) {
        const platform = p.platform === 'twitter' ? 'X' : 'LI'
        const statusIcon = { draft: '\ud83d\udcdd', approved: '\u2705', published: '\ud83d\ude80', rejected: '\u274c', failed: '\u26a0\ufe0f' }[p.status]
        console.log(`${statusIcon} [${p.id}] ${platform} | ${p.status} | ${p.content.slice(0, 60)}`)
      }
      break
    }

    case 'show': {
      const id = args[1]
      if (!id) { console.error('Usage: show <id>'); process.exit(1) }
      const post = getPost(id)
      if (!post) { console.error(`Post ${id} not found`); process.exit(1) }
      console.log(JSON.stringify(post, null, 2))
      break
    }

    case 'approve': {
      const id = args[1]
      if (!id) { console.error('Usage: approve <id>'); process.exit(1) }
      const result = await approveAndPublish(id)
      if (result.published) {
        console.log(`Published: ${result.post.platform_url}`)
      } else {
        console.error(`Failed: ${result.error}`)
        process.exit(1)
      }
      break
    }

    case 'reject': {
      const id = args[1]
      if (!id) { console.error('Usage: reject <id>'); process.exit(1) }
      const ok = reject(id)
      console.log(ok ? 'Rejected' : 'Failed to reject (wrong status?)')
      break
    }

    case 'stats': {
      const stats = getPostStats()
      console.log(`Drafts: ${stats.drafts}`)
      console.log(`Published: ${stats.published}`)
      console.log(`Rejected: ${stats.rejected}`)
      console.log(`Failed: ${stats.failed}`)
      break
    }

    case 'notify': {
      const id = args[1]
      const chatId = args[2] ?? process.env.DEFAULT_NOTIFY_CHAT_ID
      if (!id) { console.error('Usage: notify <id> <chat_id>'); process.exit(1) }
      if (!chatId) {
        console.error('Error: chat_id required. Pass as arg or set DEFAULT_NOTIFY_CHAT_ID env var.')
        process.exit(1)
      }
      await sendTelegramDraftNotification(id, chatId)
      break
    }

    default:
      console.log(`Social CLI - Manage social media posts

Commands:
  draft <twitter|linkedin> <content> [--cta "text"] [--media "url"] [--time "time"]
  list [draft|approved|published|rejected|failed]
  show <id>
  approve <id>
  reject <id>
  stats
  notify <id> [chat_id]  - Send draft to Telegram with approve/reject buttons`)
      break
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
