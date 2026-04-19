import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export type ChatRole = 'user' | 'assistant' | 'agent'

export interface ResearchChatMessage {
  id: string
  item_id: string
  role: ChatRole
  body: string
  agent_job: string | null
  created_at: number
}

export interface ResearchItemContext {
  id: string
  topic: string
  source: string
  source_url: string
  category: string
  score: number
  status: string
  pipeline: string | null
  notes: string
  competitor: string
  created_at: number
}

export function getChatHistory(db: Database.Database, itemId: string): ResearchChatMessage[] {
  return db
    .prepare('SELECT * FROM research_chat_messages WHERE item_id = ? ORDER BY created_at ASC')
    .all(itemId) as ResearchChatMessage[]
}

export function saveChatMessage(db: Database.Database, msg: ResearchChatMessage): void {
  db.prepare(`
    INSERT INTO research_chat_messages (id, item_id, role, body, agent_job, created_at)
    VALUES (@id, @item_id, @role, @body, @agent_job, @created_at)
  `).run(msg)
}

export function makeChatMessage(
  itemId: string,
  role: ChatRole,
  body: string,
  agentJob?: string,
): ResearchChatMessage {
  return {
    id: randomUUID(),
    item_id: itemId,
    role,
    body,
    agent_job: agentJob ?? null,
    created_at: Date.now(),
  }
}

export function buildScoutContext(
  item: ResearchItemContext,
  history: ResearchChatMessage[],
  userMessage: string,
  init = false,
): string {
  const lines: string[] = []

  lines.push('You are Scout, reviewing a research item with the user inside the ClaudePaw dashboard.')
  lines.push('')
  lines.push('RESEARCH ITEM:')
  lines.push(`Topic: ${item.topic}`)
  lines.push(`Source: ${item.source} (${item.source_url})`)
  lines.push(`Category: ${item.category}`)
  lines.push(`Score: ${item.score}/100`)
  lines.push(`Status: ${item.status}`)
  lines.push(`Pipeline: ${item.pipeline ?? 'not assigned'}`)
  lines.push(`Notes: ${item.notes || 'none'}`)
  lines.push(`Competitor: ${item.competitor || 'none'}`)
  lines.push(`Found: ${new Date(item.created_at).toISOString()}`)

  if (history.length > 0) {
    lines.push('')
    lines.push('CONVERSATION HISTORY:')
    for (const msg of history) {
      const label = msg.role === 'agent' ? 'Agent' : msg.role === 'user' ? 'User' : 'Assistant'
      lines.push(`${label}: ${msg.body}`)
    }
  }

  if (!init) {
    lines.push('')
    lines.push('USER MESSAGE:')
    lines.push(userMessage)
  }

  lines.push('')
  lines.push('INSTRUCTIONS:')
  if (init) {
    lines.push(
      "Summarize why this item matters and what angle fits the project's audience. Keep it tight, under 100 words.",
    )
  } else {
    lines.push(
      'Continue the conversation. Help the user decide what to do with this item. If they want to draft content, ' +
      'archive, or move pipeline stage, tell them which button to click in the drawer. ' +
      'Be direct. No preamble. No AI cliches. No em dashes.',
    )
  }

  return lines.join('\n')
}
