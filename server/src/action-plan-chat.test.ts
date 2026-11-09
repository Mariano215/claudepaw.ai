import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  saveChatMessage,
  getChatHistory,
  buildAgentPrompt,
  type ChatMessage,
  type ActionItemContext,
} from './action-plan-chat.js'

function makeTestDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE action_item_chat_messages (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'agent')),
      body TEXT NOT NULL,
      agent_job TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  return db
}

const testItem: ActionItemContext = {
  id: 'item-1',
  title: 'Fix login bug',
  description: 'Users cannot log in with SSO.',
  priority: 'high',
  status: 'open',
  project_id: 'default',
}

describe('getChatHistory', () => {
  it('returns empty array when no messages exist', () => {
    const db = makeTestDb()
    const result = getChatHistory(db, 'item-1')
    expect(result).toEqual([])
  })

  it('returns messages ordered by created_at ascending', () => {
    const db = makeTestDb()
    saveChatMessage(db, { id: 'msg-1', item_id: 'item-1', role: 'user', body: 'hello', agent_job: null, created_at: 2000 })
    saveChatMessage(db, { id: 'msg-2', item_id: 'item-1', role: 'assistant', body: 'hi', agent_job: null, created_at: 1000 })
    const result = getChatHistory(db, 'item-1')
    expect(result[0].id).toBe('msg-2')
    expect(result[1].id).toBe('msg-1')
  })

  it('only returns messages for the given item_id', () => {
    const db = makeTestDb()
    saveChatMessage(db, { id: 'msg-1', item_id: 'item-1', role: 'user', body: 'hello', agent_job: null, created_at: 1000 })
    saveChatMessage(db, { id: 'msg-2', item_id: 'item-2', role: 'user', body: 'other', agent_job: null, created_at: 1001 })
    const result = getChatHistory(db, 'item-1')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('msg-1')
  })
})

describe('saveChatMessage', () => {
  it('persists a message and retrieves it', () => {
    const db = makeTestDb()
    const msg: ChatMessage = { id: 'msg-1', item_id: 'item-1', role: 'assistant', body: 'test body', agent_job: null, created_at: 1000 }
    saveChatMessage(db, msg)
    const result = getChatHistory(db, 'item-1')
    expect(result[0]).toMatchObject({ id: 'msg-1', role: 'assistant', body: 'test body' })
  })
})

describe('buildAgentPrompt', () => {
  it('includes action item fields', () => {
    const prompt = buildAgentPrompt(testItem, [], '', true)
    expect(prompt).toContain('Fix login bug')
    expect(prompt).toContain('Users cannot log in with SSO.')
    expect(prompt).toContain('high')
    expect(prompt).toContain('open')
    expect(prompt).toContain('default')
  })

  it('omits conversation history section when history is empty', () => {
    const prompt = buildAgentPrompt(testItem, [], '', true)
    expect(prompt).not.toContain('CONVERSATION HISTORY')
  })

  it('includes conversation history when present', () => {
    const history: ChatMessage[] = [
      { id: '1', item_id: 'item-1', role: 'user', body: 'What does this mean?', agent_job: null, created_at: 1000 },
      { id: '2', item_id: 'item-1', role: 'assistant', body: 'It means the SSO config is broken.', agent_job: null, created_at: 2000 },
    ]
    const prompt = buildAgentPrompt(testItem, history, 'Fix it now', false)
    expect(prompt).toContain('CONVERSATION HISTORY')
    expect(prompt).toContain('User: What does this mean?')
    expect(prompt).toContain('Assistant: It means the SSO config is broken.')
  })

  it('labels agent history messages as Agent', () => {
    const history: ChatMessage[] = [
      { id: '1', item_id: 'item-1', role: 'agent', body: 'Done. Restarted the service.', agent_job: null, created_at: 1000 },
    ]
    const prompt = buildAgentPrompt(testItem, history, 'Good', false)
    expect(prompt).toContain('Agent: Done. Restarted the service.')
  })

  it('includes user message when init=false', () => {
    const prompt = buildAgentPrompt(testItem, [], 'Please fix this now', false)
    expect(prompt).toContain('USER MESSAGE:')
    expect(prompt).toContain('Please fix this now')
  })

  it('omits user message when init=true', () => {
    const prompt = buildAgentPrompt(testItem, [], 'ignored', true)
    expect(prompt).not.toContain('USER MESSAGE')
    expect(prompt).not.toContain('ignored')
  })

  it('uses init instructions when init=true', () => {
    const prompt = buildAgentPrompt(testItem, [], '', true)
    expect(prompt).toContain('start of the conversation')
  })

  it('uses continuation instructions when init=false', () => {
    const prompt = buildAgentPrompt(testItem, [], 'do it', false)
    expect(prompt).toContain('Continue the conversation')
  })
})
