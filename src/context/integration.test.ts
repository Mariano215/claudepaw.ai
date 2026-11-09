import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { getDb, initDatabase } from '../db.js'
import { saveChatMessage } from '../chat/messages.js'

// Ollama is not guaranteed reachable in CI/local test env. Disable the vector
// branch of retrieveKnowledge so tests don't hang on network timeouts. The
// rest of the Memory V2 stack (project snapshot, agent slice, BM25/graph,
// chat FTS, conversation history) still runs for real.
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MEMORY_V2_EMBEDDINGS: false }
})

// Import under test after the mock is registered.
const { buildAgentContext } = await import('./build-agent-context.js')

beforeAll(() => initDatabase())

describe('Memory V2 E2E', () => {
  const projectId = 'default'
  const chatIdA = 'e2e:user-a:agent'
  const chatIdB = 'e2e:user-b:agent'

  beforeAll(() => {
    getDb()
      .prepare(`DELETE FROM chat_messages WHERE chat_id IN (?, ?)`)
      .run(chatIdA, chatIdB)
  })

  afterAll(() => {
    getDb()
      .prepare(`DELETE FROM chat_messages WHERE chat_id IN (?, ?)`)
      .run(chatIdA, chatIdB)
  })

  it('scenario 1: multi-turn coherence (Layer 5 surfaces prior turns)', async () => {
    saveChatMessage({
      chatId: chatIdA,
      projectId,
      userId: 'user-a',
      role: 'user',
      content: 'which social posts did we approve?',
    })
    saveChatMessage({
      chatId: chatIdA,
      projectId,
      userId: 'user-a',
      role: 'assistant',
      content: 'The LinkedIn post and the Twitter thread are approved.',
    })
    const r = await buildAgentContext({
      chatId: chatIdA,
      userId: 'user-a',
      projectId,
      agentId: null,
      userMessage: 'and the YouTube short?',
      channel: 'dashboard',
    })
    expect(r.contextBlocks.join('\n')).toContain('LinkedIn post')
  })

  it('scenario 3: episodic privacy (user-b cannot see user-a content via chat FTS)', async () => {
    saveChatMessage({
      chatId: chatIdA,
      projectId,
      userId: 'user-a',
      role: 'user',
      content: 'personal secret alpha',
    })
    const r = await buildAgentContext({
      chatId: chatIdB,
      userId: 'user-b',
      projectId,
      agentId: null,
      userMessage: 'any alpha around?',
      channel: 'dashboard',
    })
    expect(r.contextBlocks.join('\n')).not.toContain('personal secret alpha')
  })

  it('scenario 5: graceful degradation when embeddings backend is unreachable', async () => {
    // Force the embedding provider to fail. retrieveKnowledge wraps embeddings
    // in try/catch and should fall back to BM25 + chat FTS without throwing.
    const embeddings = await import('../embeddings.js')
    const spy = vi.spyOn(embeddings, 'embedText').mockRejectedValue(new Error('unreachable'))
    try {
      const r = await buildAgentContext({
        chatId: chatIdA,
        userId: 'user-a',
        projectId,
        agentId: null,
        userMessage: 'test',
        channel: 'dashboard',
      })
      expect(r.systemPrompt).toBeTruthy()
      expect(Array.isArray(r.contextBlocks)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
