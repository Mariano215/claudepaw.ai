import { getDb } from '../db.js'
import { logger } from '../logger.js'

export interface ChatMessage {
  id: number
  chat_id: string
  project_id: string
  user_id: string | null
  role: 'user' | 'assistant'
  content: string
  tool_calls: string | null
  token_count: number | null
  created_at: number
  summarized_at: number | null
}

export interface SaveChatMessageInput {
  chatId: string
  projectId: string
  userId: string | null
  role: 'user' | 'assistant'
  content: string
  toolCalls?: unknown[]
  tokenCount?: number
}

export function saveChatMessage(input: SaveChatMessageInput): number {
  const result = getDb().prepare(`
    INSERT INTO chat_messages (chat_id, project_id, user_id, role, content, tool_calls, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.chatId, input.projectId, input.userId, input.role, input.content,
    input.toolCalls ? JSON.stringify(input.toolCalls) : null,
    input.tokenCount ?? null, Date.now())
  return Number(result.lastInsertRowid)
}

export function getChatMessages(chatId: string, opts: { limit: number; before?: number }): ChatMessage[] {
  const db = getDb()
  if (opts.before !== undefined) {
    return db.prepare(`SELECT * FROM chat_messages WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(chatId, opts.before, opts.limit) as ChatMessage[]
  }
  return db.prepare(`SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(chatId, opts.limit) as ChatMessage[]
}

export function searchChatMessages(opts: { query: string; userId: string | null; limit: number; sinceMs?: number }): ChatMessage[] {
  if (!opts.query.trim()) return []
  const sanitized = opts.query.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/).filter(Boolean).map(w => `${w}*`).join(' ')
  if (!sanitized) return []
  const since = opts.sinceMs ?? 0
  try {
    if (opts.userId) {
      return getDb().prepare(`
        SELECT m.* FROM chat_messages m JOIN chat_messages_fts f ON f.rowid = m.id
        WHERE chat_messages_fts MATCH ? AND m.user_id = ? AND m.created_at >= ?
        ORDER BY m.created_at DESC, m.id DESC LIMIT ?
      `).all(sanitized, opts.userId, since, opts.limit) as ChatMessage[]
    }
    return getDb().prepare(`
      SELECT m.* FROM chat_messages m JOIN chat_messages_fts f ON f.rowid = m.id
      WHERE chat_messages_fts MATCH ? AND m.created_at >= ?
      ORDER BY m.created_at DESC, m.id DESC LIMIT ?
    `).all(sanitized, since, opts.limit) as ChatMessage[]
  } catch (err) {
    logger.warn({ err, q: opts.query }, 'searchChatMessages failed')
    return []
  }
}

export function countChatMessages(chatId: string): number {
  return (getDb().prepare('SELECT COUNT(*) as c FROM chat_messages WHERE chat_id = ?').get(chatId) as {c:number}).c
}

export function markMessagesSummarized(ids: number[], summarizedAt: number): void {
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  getDb().prepare(`UPDATE chat_messages SET summarized_at = ? WHERE id IN (${placeholders})`).run(summarizedAt, ...ids)
}

export function getUnsummarizedMessages(olderThanMs: number, limit: number): ChatMessage[] {
  return getDb().prepare(`
    SELECT * FROM chat_messages WHERE summarized_at IS NULL AND created_at < ?
    ORDER BY chat_id, created_at ASC LIMIT ?
  `).all(olderThanMs, limit) as ChatMessage[]
}
