import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import { saveChatMessage } from '../chat/messages.js'
import { getDb, initDatabase } from '../db.js'

// Disable vector retrieval for tests — no Ollama available in CI/local test env.
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MEMORY_V2_EMBEDDINGS: false }
})

// Import under test after mocks are registered.
const { buildAgentContext } = await import('./build-agent-context.js')

beforeAll(() => initDatabase())

describe('buildAgentContext', () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM chat_messages WHERE chat_id LIKE 'bac-test:%'").run()
  })
  it('returns all output fields', async () => {
    const r = await buildAgentContext({ chatId:'bac-test:empty', userId:'u1', projectId:'default', agentId:null, userMessage:'hi', channel:'dashboard' })
    expect(typeof r.systemPrompt).toBe('string')
    expect(Array.isArray(r.contextBlocks)).toBe(true)
    expect(Array.isArray(r.historyFallback)).toBe(true)
    expect(typeof r.tokenEstimate).toBe('number')
    expect(typeof r.layerTimings).toBe('object')
  })
  it('includes history when messages exist', async () => {
    saveChatMessage({ chatId:'bac-test:h', projectId:'default', userId:'u1', role:'user', content:'prior question' })
    saveChatMessage({ chatId:'bac-test:h', projectId:'default', userId:'u1', role:'assistant', content:'prior answer' })
    const r = await buildAgentContext({ chatId:'bac-test:h', userId:'u1', projectId:'default', agentId:null, userMessage:'follow up', channel:'dashboard' })
    const joined = r.contextBlocks.join('\n')
    expect(joined).toMatch(/prior question|prior answer/)
  })
  it('does not throw when a layer fails', async () => {
    const r = await buildAgentContext({ chatId:'bac-test:r', userId:'u1', projectId:'nonexistent', agentId:null, userMessage:'t', channel:'dashboard' })
    expect(r.systemPrompt).toBeTruthy()
  })
})
