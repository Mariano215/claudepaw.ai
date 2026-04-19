#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// YouTube Video Publish Script
//
// Creates a social draft for YouTube, sends to Telegram for approval.
// Approval triggers upload as unlisted (default) to YouTube.
//
// Usage:
//   tsx scripts/youtube-publish.ts <video_path> --title "Title" --desc "Description" [options]
//
// Options:
//   --title "Title"              Video title (required)
//   --desc "Description"         Video description (required)
//   --tags "tag1,tag2,tag3"      Comma-separated tags
//   --thumbnail "/path/to.png"   Thumbnail image path
//   --visibility "unlisted"      private|unlisted|public (default: unlisted)
//   --category "28"              YouTube category ID (default: 28 = Science & Technology)
//   --project "default"   Project ID (default: default)
//   --chat "123456789"           Telegram chat ID for approval notification
// ---------------------------------------------------------------------------

import { initDatabase } from '../src/db.js'
import { initSocial, draft } from '../src/social/index.js'
import { BOT_TOKEN } from '../src/config.js'

const db = initDatabase()
initSocial(db)

function parseArgs(argv: string[]): { videoPath: string; flags: Record<string, string> } {
  const videoPath = argv[0]
  const flags: Record<string, string> = {}
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[i + 1]
      i++
    }
  }
  return { videoPath, flags }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function main() {
  const args = process.argv.slice(2)
  const { videoPath, flags } = parseArgs(args)

  if (!videoPath || !flags.title) {
    console.error('Usage: tsx scripts/youtube-publish.ts <video_path> --title "Title" --desc "Description"')
    console.error('  --tags "tag1,tag2" --thumbnail "/path.png" --visibility "unlisted" --chat "123456789"')
    process.exit(1)
  }

  // Build YouTube metadata JSON for the CTA field
  const ytMeta = JSON.stringify({
    title: flags.title,
    tags: flags.tags?.split(',').map(t => t.trim()) ?? [],
    categoryId: flags.category ?? '28',
    visibility: flags.visibility ?? 'unlisted',
    thumbnailPath: flags.thumbnail,
  })

  const post = draft({
    platform: 'youtube',
    content: flags.desc ?? flags.title,
    media_url: videoPath,
    cta: ytMeta,
    created_by: 'producer',
    project_id: flags.project ?? 'default',
  })

  console.log(`YouTube draft created: ${post.id}`)
  console.log(`Video: ${videoPath}`)
  console.log(`Title: ${flags.title}`)
  console.log(`Visibility: ${flags.visibility ?? 'unlisted'}`)

  // Send Telegram notification for approval
  const chatId = flags.chat ?? '123456789'
  const preview = (flags.desc ?? flags.title).slice(0, 200)

  const text = `\u25b6\ufe0f YouTube <b>Draft</b> [${post.id}]\n\n` +
    `<b>Title:</b> ${escapeHtml(flags.title)}\n` +
    `${escapeHtml(preview)}\n\n` +
    `Visibility: ${flags.visibility ?? 'unlisted'}\n` +
    (flags.tags ? `Tags: ${escapeHtml(flags.tags)}\n` : '') +
    `Video: ${escapeHtml(videoPath)}\n\n` +
    `To approve: <code>npm run social approve ${post.id}</code>`

  const keyboard = {
    inline_keyboard: [
      [
        { text: '\u2705 Upload to YouTube', callback_data: `social:approve:${post.id}` },
        { text: '\u274c Reject', callback_data: `social:reject:${post.id}` },
      ],
    ],
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      console.error(`Telegram notification failed: ${body}`)
    } else {
      console.log(`Approval request sent to Telegram chat ${chatId}`)
    }
  } catch (err) {
    console.error(`Telegram notification error: ${err}`)
  }

  console.log(`\nTo approve manually: npm run social approve ${post.id}`)
}

main().catch(console.error)
