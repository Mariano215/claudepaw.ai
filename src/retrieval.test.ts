import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase } from './db.js'
import { upsertEntity, addObservation } from './knowledge.js'
import { _rrfMerge, _formatKnowledgeContext, type KnowledgeHit } from './retrieval.js'

beforeAll(() => {
  initDatabase()
  const entityId = upsertEntity({ name: 'NewsletterSOP', type: 'sop', summary: 'Newsletter pipeline SOP', projectId: null })
  addObservation({ entityId, content: 'trigger via run_task("asymmetric-newsletter")', source: 'authored', confidence: 1.0 })
})

describe('_rrfMerge', () => {
  it('gives higher score to hits appearing in both lists', () => {
    const bm25: KnowledgeHit[] = [
      { targetType: 'observation', targetId: 1, content: 'fact one', entityName: 'A', score: 0 },
      { targetType: 'observation', targetId: 2, content: 'fact two', entityName: 'B', score: 0 },
    ]
    const vec: KnowledgeHit[] = [
      { targetType: 'observation', targetId: 2, content: 'fact two', entityName: 'B', score: 0 },
      { targetType: 'observation', targetId: 3, content: 'fact three', entityName: 'C', score: 0 },
    ]
    const merged = _rrfMerge(bm25, vec, 3)
    expect(merged[0].targetId).toBe(2)
    expect(merged.length).toBeLessThanOrEqual(3)
  })

  it('deduplicates by targetId', () => {
    const hits: KnowledgeHit[] = [
      { targetType: 'observation', targetId: 99, content: 'dup', entityName: 'X', score: 0 },
      { targetType: 'observation', targetId: 99, content: 'dup', entityName: 'X', score: 0 },
    ]
    const merged = _rrfMerge(hits, [], 10)
    expect(merged.length).toBe(1)
  })
})

describe('_formatKnowledgeContext', () => {
  it('returns empty string for empty hits', () => {
    expect(_formatKnowledgeContext([])).toBe('')
  })

  it('formats hits into readable block with header', () => {
    const hits: KnowledgeHit[] = [
      { targetType: 'observation', targetId: 1, content: 'iOS SSH app over Tailscale', entityName: 'ExampleApp', score: 1 },
    ]
    const result = _formatKnowledgeContext(hits)
    expect(result).toContain('[Knowledge context]')
    expect(result).toContain('ExampleApp')
    expect(result).toContain('iOS SSH app')
  })
})
