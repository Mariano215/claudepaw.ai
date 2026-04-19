#!/usr/bin/env node
import { getDb, initDatabase } from '../src/db.js'
import { saveChatMessage } from '../src/chat/messages.js'
import { logger } from '../src/logger.js'

async function main() {
  initDatabase()
  const db = getDb()

  const rows = db.prepare(`SELECT * FROM memories ORDER BY created_at ASC`).all() as Array<{
    id: number
    chat_id: string
    content: string
    created_at: number
    project_id: string | null
  }>
  logger.info({ count: rows.length }, 'migrate legacy')

  let migrated = 0
  for (const r of rows) {
    const match = r.content.match(/^User:\s*([\s\S]*?)\nAssistant:\s*([\s\S]*)$/)
    if (!match) continue
    const [, userText, asstText] = match
    const projectId = r.project_id ?? 'default'
    const userId = r.chat_id.split(':')[1] ?? null

    const u = saveChatMessage({ chatId: r.chat_id, projectId, userId, role: 'user', content: userText })
    const a = saveChatMessage({ chatId: r.chat_id, projectId, userId, role: 'assistant', content: asstText })

    db.prepare('UPDATE chat_messages SET created_at = ? WHERE id = ?').run(r.created_at, u)
    db.prepare('UPDATE chat_messages SET created_at = ? WHERE id = ?').run(r.created_at + 1, a)
    migrated++
  }

  logger.info({ migrated }, 'migrate done')
}

main().catch(err => { logger.error({ err }, 'migrate failed'); process.exit(1) })
