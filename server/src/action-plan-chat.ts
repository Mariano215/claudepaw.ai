import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatRole = 'user' | 'assistant' | 'agent'

export interface ChatMessage {
  id: string
  item_id: string
  role: ChatRole
  body: string
  agent_job: string | null
  created_at: number
}

export interface ActionItemContext {
  id: string
  title: string
  description: string | null
  priority: string
  status: string
  project_id: string
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

export function getChatHistory(db: Database.Database, itemId: string): ChatMessage[] {
  return db
    .prepare('SELECT * FROM action_item_chat_messages WHERE item_id = ? ORDER BY created_at ASC')
    .all(itemId) as ChatMessage[]
}

export function saveChatMessage(db: Database.Database, msg: ChatMessage): void {
  db.prepare(`
    INSERT INTO action_item_chat_messages (id, item_id, role, body, agent_job, created_at)
    VALUES (@id, @item_id, @role, @body, @agent_job, @created_at)
  `).run(msg)
}

export function makeChatMessage(itemId: string, role: ChatRole, body: string, agentJob?: string): ChatMessage {
  return {
    id: randomUUID(),
    item_id: itemId,
    role,
    body,
    agent_job: agentJob ?? null,
    created_at: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Agent prompt builder
// ---------------------------------------------------------------------------

export function buildAgentPrompt(
  item: ActionItemContext,
  history: ChatMessage[],
  userMessage: string,
  init = false,
): string {
  const lines: string[] = []

  lines.push('You are embedded inside the ClaudePaw dashboard, helping resolve a specific action plan item.')
  lines.push('')
  lines.push('ACTION PLAN ITEM:')
  lines.push(`Title: ${item.title}`)
  lines.push(`Description: ${item.description ?? 'No description provided.'}`)
  lines.push(`Priority: ${item.priority}`)
  lines.push(`Status: ${item.status}`)
  lines.push(`Project: ${item.project_id}`)

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
      'This is the start of the conversation. Explain what this action plan item means in plain terms. ' +
      'Assess what can be automated vs. what requires human input. Be concise and direct.',
    )
  } else {
    lines.push(
      'Continue the conversation. If you can execute steps autonomously, use your available tools and do the work. ' +
      'If steps require human input (credentials, approvals, account access, judgment calls), say so explicitly. ' +
      'Be direct. No preamble. No AI cliches. No em dashes.',
    )
  }

  return lines.join('\n')
}
