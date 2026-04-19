import { createBudget } from './budget.js'
import { buildProjectSnapshot } from './project-snapshot.js'
import { buildAgentSlice } from './agent-slice.js'
import { retrieveKnowledge } from './retrieve-knowledge.js'
import { buildConversationHistory } from './conversation-history.js'
import { getSession } from '../db.js'
import { getSoul, buildAgentPrompt } from '../souls.js'
import { logger } from '../logger.js'
import { MEMORY_V2_PROJECT_SNAPSHOT, MEMORY_V2_AGENT_SLICE } from '../config.js'

export interface AgentContextInput {
  chatId: string
  userId: string | null
  projectId: string
  agentId: string | null
  userMessage: string
  channel: string
}

export interface AgentContextOutput {
  systemPrompt: string
  contextBlocks: string[]
  sessionId: string | null
  historyFallback: Array<{ role: 'user' | 'assistant'; content: string }>
  tokenEstimate: number
  layerTimings: Record<string, number>
}

const TOTAL_BUDGET = 6000
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.'

export async function buildAgentContext(input: AgentContextInput): Promise<AgentContextOutput> {
  const budget = createBudget(TOTAL_BUDGET)
  const timings: Record<string, number> = {}
  const blocks: string[] = []

  let systemPrompt = DEFAULT_SYSTEM_PROMPT
  const soul = input.agentId ? getSoul(input.agentId, input.projectId) : null
  if (soul) {
    try {
      systemPrompt = buildAgentPrompt(soul, input.projectId)
    } catch (err) {
      logger.warn({ err }, 'buildAgentPrompt failed')
    }
  }

  if (MEMORY_V2_PROJECT_SNAPSHOT) {
    const t0 = Date.now()
    try {
      const s = await buildProjectSnapshot(input.projectId, budget)
      if (s) blocks.push(s)
    } catch (err) {
      logger.warn({ err }, 'project snapshot failed')
    }
    timings.projectSnapshot = Date.now() - t0
  }

  if (MEMORY_V2_AGENT_SLICE && soul?.context_slice) {
    const t0 = Date.now()
    try {
      const s = await buildAgentSlice(soul.context_slice, input.projectId, budget)
      if (s) blocks.push(s)
    } catch (err) {
      logger.warn({ err }, 'agent slice failed')
    }
    timings.agentSlice = Date.now() - t0
  }

  {
    const t0 = Date.now()
    try {
      const k = await retrieveKnowledge({
        query: input.userMessage,
        projectId: input.projectId,
        userId: input.userId,
        budget,
      })
      if (k) blocks.push(k)
    } catch (err) {
      logger.warn({ err }, 'knowledge retrieval failed')
    }
    timings.knowledgeRetrieval = Date.now() - t0
  }

  const session = getSession(input.chatId, input.agentId ?? undefined)
  let historyFallback: Array<{ role: 'user' | 'assistant'; content: string }> = []
  {
    const t0 = Date.now()
    try {
      const h = await buildConversationHistory({
        chatId: input.chatId,
        hasSessionResume: !!session?.session_id,
        budget,
      })
      if (h.contextBlock) blocks.push(h.contextBlock)
      historyFallback = h.messagesForFallback
    } catch (err) {
      logger.warn({ err }, 'history failed')
    }
    timings.conversationHistory = Date.now() - t0
  }

  return {
    systemPrompt,
    contextBlocks: blocks,
    sessionId: session?.session_id ?? null,
    historyFallback,
    tokenEstimate: TOTAL_BUDGET - budget.remaining,
    layerTimings: timings,
  }
}
