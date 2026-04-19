import { describe, it, expect } from 'vitest'
import { _parseExtractionResponse, _groupMessagesByChat, _detectEpisodes } from './batch.js'
import type { ChatMessage } from '../chat/messages.js'

describe('_parseExtractionResponse', () => {
  it('parses valid JSON', () => {
    const r = _parseExtractionResponse('{"entities":[{"kind":"person","name":"M","summary":""}],"observations":[],"relations":[]}')
    expect(r.entities).toHaveLength(1)
  })
  it('strips markdown fences', () => {
    const r = _parseExtractionResponse('```json\n{"entities":[],"observations":[],"relations":[]}\n```')
    expect(r.entities).toEqual([])
  })
  it('empty on invalid', () => {
    expect(_parseExtractionResponse('not json')).toEqual({entities:[],observations:[],relations:[]})
  })
})

describe('_groupMessagesByChat', () => {
  it('groups by chat_id', () => {
    const msgs = [{chat_id:'a'},{chat_id:'b'},{chat_id:'a'}] as ChatMessage[]
    const g = _groupMessagesByChat(msgs)
    expect(g.size).toBe(2)
    expect(g.get('a')?.length).toBe(2)
  })
})

describe('_detectEpisodes', () => {
  it('splits on 4h gaps', () => {
    const h = 3600_000
    const msgs = [{created_at:1*h},{created_at:2*h},{created_at:10*h},{created_at:11*h}] as ChatMessage[]
    const ep = _detectEpisodes(msgs, 4 * h)
    expect(ep).toHaveLength(2)
  })
})
