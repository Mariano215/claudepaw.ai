import { getDb } from '../db.js'

export interface ChatSummary {
  id: number
  chat_id: string
  project_id: string
  period_start: number
  period_end: number
  message_count: number
  summary: string
  key_topics: string | null
  created_at: number
}

export interface SaveChatSummaryInput {
  chatId: string
  projectId: string
  periodStart: number
  periodEnd: number
  messageCount: number
  summary: string
  keyTopics?: string[]
}

export function saveChatSummary(input: SaveChatSummaryInput): number {
  const result = getDb().prepare(`
    INSERT INTO chat_summaries (chat_id, project_id, period_start, period_end, message_count, summary, key_topics, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.chatId,
    input.projectId,
    input.periodStart,
    input.periodEnd,
    input.messageCount,
    input.summary,
    input.keyTopics ? JSON.stringify(input.keyTopics) : null,
    Date.now(),
  )
  return Number(result.lastInsertRowid)
}

export function getChatSummaries(chatId: string, opts: { before?: number; limit: number }): ChatSummary[] {
  const db = getDb()
  if (opts.before !== undefined) {
    return db.prepare(`SELECT * FROM chat_summaries WHERE chat_id = ? AND period_end < ? ORDER BY period_end DESC LIMIT ?`)
      .all(chatId, opts.before, opts.limit) as ChatSummary[]
  }
  return db.prepare(`SELECT * FROM chat_summaries WHERE chat_id = ? ORDER BY period_end DESC LIMIT ?`)
    .all(chatId, opts.limit) as ChatSummary[]
}
