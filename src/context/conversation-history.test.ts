import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { saveChatMessage } from '../chat/messages.js'
import { saveChatSummary } from '../chat/summaries.js'
import { buildConversationHistory } from './conversation-history.js'
import { createBudget } from './budget.js'

beforeAll(() => {
  initDatabase()
})

describe('buildConversationHistory', () => {
  beforeEach(() => {
    const db = getDb()
    db.prepare("DELETE FROM chat_messages WHERE chat_id LIKE 'ch-test:%'").run()
    db.prepare("DELETE FROM chat_summaries WHERE chat_id LIKE 'ch-test:%'").run()
  })

  it('empty when no history', async () => {
    const r = await buildConversationHistory({ chatId:'ch-test:empty', hasSessionResume:false, budget:createBudget(2000) })
    expect(r.contextBlock).toBe('')
    expect(r.messagesForFallback).toEqual([])
  })

  it('session-resume mode: last 3 turns as refresher', async () => {
    for (let i = 1; i <= 5; i++) {
      saveChatMessage({ chatId:'ch-test:resume', projectId:'default', userId:'u1', role:'user', content:'u'+i })
      saveChatMessage({ chatId:'ch-test:resume', projectId:'default', userId:'u1', role:'assistant', content:'a'+i })
    }
    const r = await buildConversationHistory({ chatId:'ch-test:resume', hasSessionResume:true, budget:createBudget(2000) })
    expect(r.contextBlock).toContain('[Recent turns]')
    expect(r.messagesForFallback).toEqual([])
  })

  it('reconstruct mode: last 10 turns + older summaries', async () => {
    for (let i = 1; i <= 15; i++) {
      saveChatMessage({ chatId:'ch-test:recon', projectId:'default', userId:'u1', role:'user', content:'user turn '+i })
      saveChatMessage({ chatId:'ch-test:recon', projectId:'default', userId:'u1', role:'assistant', content:'assistant turn '+i })
    }
    saveChatSummary({ chatId:'ch-test:recon', projectId:'default', periodStart:Date.now()-86400000, periodEnd:Date.now()-3600000, messageCount:10, summary:'Earlier we discussed launch plans' })
    const r = await buildConversationHistory({ chatId:'ch-test:recon', hasSessionResume:false, budget:createBudget(3000) })
    expect(r.contextBlock).toContain('[Conversation history]')
    expect(r.contextBlock).toContain('Earlier we discussed launch plans')
    expect(r.messagesForFallback.length).toBe(10)
  })
})
