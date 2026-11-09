import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { saveChatMessage, getChatMessages, searchChatMessages, type ChatMessage } from './messages.js'

beforeAll(() => {
  initDatabase()
})

describe('memory-v2 schema', () => {
  it('has chat_messages table', () => {
    const cols = getDb().prepare('PRAGMA table_info(chat_messages)').all() as Array<{name: string}>
    const names = cols.map(c => c.name).sort()
    expect(names).toEqual(['chat_id','content','created_at','id','project_id','role','summarized_at','token_count','tool_calls','user_id'])
  })

  it('has chat_summaries table', () => {
    const cols = getDb().prepare('PRAGMA table_info(chat_summaries)').all() as Array<{name: string}>
    expect(cols.map(c => c.name)).toContain('period_start')
    expect(cols.map(c => c.name)).toContain('summary')
  })

  it('has extraction_runs table', () => {
    const cols = getDb().prepare('PRAGMA table_info(extraction_runs)').all() as Array<{name: string}>
    expect(cols.map(c => c.name)).toContain('run_type')
    expect(cols.map(c => c.name)).toContain('status')
  })

  it('has chat_messages_fts virtual table', () => {
    const r = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_messages_fts'").get()
    expect(r).toBeTruthy()
  })
})

describe('entities/observations ALTERs', () => {
  it('entities.last_seen_at exists', () => {
    const cols = getDb().prepare('PRAGMA table_info(entities)').all() as Array<{name:string}>
    expect(cols.map(c => c.name)).toContain('last_seen_at')
  })
  it('observations.source_id exists', () => {
    const cols = getDb().prepare('PRAGMA table_info(observations)').all() as Array<{name:string}>
    expect(cols.map(c => c.name)).toContain('source_id')
  })
  it('observations.occurred_at exists', () => {
    const cols = getDb().prepare('PRAGMA table_info(observations)').all() as Array<{name:string}>
    expect(cols.map(c => c.name)).toContain('occurred_at')
  })
  it('observations.project_id exists', () => {
    const cols = getDb().prepare('PRAGMA table_info(observations)').all() as Array<{name:string}>
    expect(cols.map(c => c.name)).toContain('project_id')
  })
})

describe('chat_messages CRUD', () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM chat_messages WHERE chat_id LIKE 'test:%' OR chat_id LIKE 'fts-test:%'")
  })

  it('saves and retrieves newest-first', () => {
    saveChatMessage({ chatId:'test:a', projectId:'default', userId:'u1', role:'user', content:'first' })
    saveChatMessage({ chatId:'test:a', projectId:'default', userId:'u1', role:'assistant', content:'second' })
    const msgs = getChatMessages('test:a', { limit: 10 })
    expect(msgs[0].content).toBe('second')
    expect(msgs[1].content).toBe('first')
  })

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      saveChatMessage({ chatId:'test:b', projectId:'default', userId:'u1', role:'user', content:'m'+i })
    }
    expect(getChatMessages('test:b', { limit: 3 })).toHaveLength(3)
  })

  it('stores tool_calls as JSON', () => {
    saveChatMessage({ chatId:'test:c', projectId:'default', userId:'u1', role:'assistant', content:'done', toolCalls:[{tool:'bash'}] })
    const msgs = getChatMessages('test:c', { limit: 1 })
    expect(JSON.parse(msgs[0].tool_calls!)).toEqual([{tool:'bash'}])
  })

  it('FTS finds by keyword scoped to userId', () => {
    saveChatMessage({ chatId:'fts-test:u1', projectId:'default', userId:'u1', role:'user', content:'launch date May 15' })
    saveChatMessage({ chatId:'fts-test:u2', projectId:'default', userId:'u2', role:'user', content:'launch date May 15' })
    const hits = searchChatMessages({ query:'launch', userId:'u1', limit: 10 })
    expect(hits.every(h => h.user_id === 'u1')).toBe(true)
  })

  it('FTS returns empty on empty query', () => {
    expect(searchChatMessages({ query:'', userId:'u1', limit:10 })).toEqual([])
  })
})
