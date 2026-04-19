import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { getDb, initDatabase } from '../db.js'
import { saveChatMessage } from '../chat/messages.js'
import { saveChatSummary } from '../chat/summaries.js'
import { runMonthlyCompaction } from './compact.js'

beforeAll(() => initDatabase())

describe('runMonthlyCompaction', () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM chat_messages WHERE chat_id LIKE 'compact-%'").run()
    getDb().prepare("DELETE FROM chat_summaries WHERE chat_id LIKE 'compact-%'").run()
  })
  it('deletes >1y when covered by summary', () => {
    const old = Date.now() - 400 * 86400 * 1000
    const id = saveChatMessage({ chatId:'compact-a', projectId:'default', userId:'u1', role:'user', content:'old' })
    getDb().prepare('UPDATE chat_messages SET created_at = ? WHERE id = ?').run(old, id)
    saveChatSummary({ chatId:'compact-a', projectId:'default', periodStart:old-1000, periodEnd:old+1000, messageCount:1, summary:'s' })
    const r = runMonthlyCompaction()
    expect(r.deleted).toBeGreaterThan(0)
    expect(getDb().prepare('SELECT id FROM chat_messages WHERE id = ?').get(id)).toBeUndefined()
  })
  it('keeps uncovered rows', () => {
    const old = Date.now() - 400 * 86400 * 1000
    const id = saveChatMessage({ chatId:'compact-b', projectId:'default', userId:'u1', role:'user', content:'uncovered' })
    getDb().prepare('UPDATE chat_messages SET created_at = ? WHERE id = ?').run(old, id)
    runMonthlyCompaction()
    expect(getDb().prepare('SELECT id FROM chat_messages WHERE id = ?').get(id)).toBeTruthy()
  })
})
