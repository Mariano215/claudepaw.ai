import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  saveChatMessage,
  getChatHistory,
  buildScoutContext,
  makeChatMessage,
  type ResearchChatMessage,
  type ResearchItemContext,
} from './research-chat.js'

function makeTestDb() {
  const db = new Database(':memory:')
  db.prepare(`
    CREATE TABLE research_chat_messages (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'agent')),
      body TEXT NOT NULL,
      agent_job TEXT,
      created_at INTEGER NOT NULL
    )
  `).run()
  return db
}

const testItem: ResearchItemContext = {
  id: 'r-1',
  topic: 'Zero-trust for SMBs',
  source: 'Hacker News',
  source_url: 'https://news.ycombinator.com/item?id=1',
  category: 'cybersecurity',
  score: 82,
  status: 'new',
  pipeline: null,
  notes: 'Mentions Tailscale and Cloudflare.',
  competitor: '',
  created_at: 1_700_000_000_000,
}

describe('getChatHistory', () => {
  it('returns empty array when no messages exist', () => {
    const db = makeTestDb()
    expect(getChatHistory(db, 'r-1')).toEqual([])
  })

  it('returns messages ordered by created_at ascending', () => {
    const db = makeTestDb()
    saveChatMessage(db, { id: 'm-1', item_id: 'r-1', role: 'user', body: 'a', agent_job: null, created_at: 2000 })
    saveChatMessage(db, { id: 'm-2', item_id: 'r-1', role: 'agent', body: 'b', agent_job: null, created_at: 1000 })
    const result = getChatHistory(db, 'r-1')
    expect(result[0].id).toBe('m-2')
    expect(result[1].id).toBe('m-1')
  })

  it('scopes by item_id', () => {
    const db = makeTestDb()
    saveChatMessage(db, { id: 'm-1', item_id: 'r-1', role: 'user', body: 'a', agent_job: null, created_at: 1000 })
    saveChatMessage(db, { id: 'm-2', item_id: 'r-2', role: 'user', body: 'b', agent_job: null, created_at: 1001 })
    expect(getChatHistory(db, 'r-1')).toHaveLength(1)
  })
})

describe('makeChatMessage', () => {
  it('generates an id and sets created_at to a current timestamp', () => {
    const before = Date.now()
    const msg = makeChatMessage('r-1', 'user', 'hello')
    const after = Date.now()
    expect(msg.id).toMatch(/[0-9a-f-]{36}/)
    expect(msg.created_at).toBeGreaterThanOrEqual(before)
    expect(msg.created_at).toBeLessThanOrEqual(after)
    expect(msg.agent_job).toBeNull()
  })

  it('stores the agent_job id when provided', () => {
    const msg = makeChatMessage('r-1', 'agent', 'reply', 'job-123')
    expect(msg.agent_job).toBe('job-123')
  })
})

describe('buildScoutContext', () => {
  it('includes all item fields', () => {
    const prompt = buildScoutContext(testItem, [], '', true)
    expect(prompt).toContain('Zero-trust for SMBs')
    expect(prompt).toContain('Hacker News')
    expect(prompt).toContain('cybersecurity')
    expect(prompt).toContain('82/100')
    expect(prompt).toContain('Mentions Tailscale and Cloudflare.')
  })

  it('handles empty optional fields', () => {
    const bare: ResearchItemContext = { ...testItem, pipeline: null, notes: '', competitor: '' }
    const prompt = buildScoutContext(bare, [], '', true)
    expect(prompt).toContain('not assigned')
    expect(prompt).toContain('none')
  })

  it('includes conversation history when present', () => {
    const history: ResearchChatMessage[] = [
      { id: '1', item_id: 'r-1', role: 'user', body: 'why does this matter?', agent_job: null, created_at: 1000 },
      { id: '2', item_id: 'r-1', role: 'agent', body: 'ties to your zero-trust series', agent_job: null, created_at: 2000 },
    ]
    const prompt = buildScoutContext(testItem, history, 'what angle?', false)
    expect(prompt).toContain('CONVERSATION HISTORY')
    expect(prompt).toContain('User: why does this matter?')
    expect(prompt).toContain('Agent: ties to your zero-trust series')
  })

  it('omits user message block when init=true', () => {
    const prompt = buildScoutContext(testItem, [], 'ignored', true)
    expect(prompt).not.toContain('USER MESSAGE')
  })

  it('includes user message when init=false', () => {
    const prompt = buildScoutContext(testItem, [], 'fresh question', false)
    expect(prompt).toContain('USER MESSAGE:')
    expect(prompt).toContain('fresh question')
  })
})
