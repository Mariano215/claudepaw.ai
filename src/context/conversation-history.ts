import { getChatMessages, type ChatMessage } from '../chat/messages.js'
import { getChatSummaries, type ChatSummary } from '../chat/summaries.js'
import { type Budget, estimateTokens } from './budget.js'

export interface HistoryInput {
  chatId: string
  hasSessionResume: boolean
  budget: Budget
}

export interface HistoryOutput {
  contextBlock: string
  messagesForFallback: Array<{ role: 'user' | 'assistant'; content: string }>
}

export async function buildConversationHistory(input: HistoryInput): Promise<HistoryOutput> {
  if (input.hasSessionResume) {
    const recent = getChatMessages(input.chatId, { limit: 3 })
    if (recent.length === 0) return { contextBlock: '', messagesForFallback: [] }
    const block = formatRecentTurns(recent)
    input.budget.consumeText(block)
    return { contextBlock: block, messagesForFallback: [] }
  }
  const raw = getChatMessages(input.chatId, { limit: 10 })
  if (raw.length === 0) return { contextBlock: '', messagesForFallback: [] }
  const summaries = getChatSummaries(input.chatId, { before: raw[raw.length - 1].created_at, limit: 3 })
  const block = formatHistoryBlock(raw, summaries, input.budget)
  return {
    contextBlock: block,
    messagesForFallback: raw.slice().reverse().map(m => ({ role: m.role, content: m.content })),
  }
}

function formatRecentTurns(messages: ChatMessage[]): string {
  const ordered = messages.slice().reverse()
  return '[Recent turns]\n' + ordered.map(m => `${m.role === 'user' ? 'You' : 'Assistant'}: ${m.content}`).join('\n')
}

function formatHistoryBlock(raw: ChatMessage[], summaries: ChatSummary[], budget: Budget): string {
  const parts: string[] = ['[Conversation history]']
  for (const s of summaries.slice().reverse()) {
    const block = `[Summary ${new Date(s.period_start).toISOString().slice(0,10)} - ${new Date(s.period_end).toISOString().slice(0,10)}, ${s.message_count} messages]\n${s.summary}`
    if (estimateTokens(block) > budget.remaining) break
    parts.push(block)
    budget.consumeText(block)
  }
  const turnLines: string[] = []
  for (const m of raw.slice().reverse()) {
    const line = `${m.role === 'user' ? 'You' : 'Assistant'}: ${m.content}`
    if (estimateTokens(line) > budget.remaining) break
    turnLines.push(line)
    budget.consumeText(line)
  }
  if (turnLines.length > 0) parts.push(turnLines.join('\n'))
  return parts.join('\n\n')
}
