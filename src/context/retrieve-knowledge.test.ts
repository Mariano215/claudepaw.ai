import { describe, it, expect } from 'vitest'
import { _rrfMerge, _formatKnowledgeBlock, type KnowledgeHit } from './retrieve-knowledge.js'

describe('_rrfMerge', () => {
  it('merges with weights', () => {
    const a: KnowledgeHit[] = [
      { kind: 'entity', id: 1, content: 'a1', entityName: 'A1', score: 1 },
      { kind: 'entity', id: 2, content: 'a2', entityName: 'A2', score: 0.5 },
    ]
    const b: KnowledgeHit[] = [
      { kind: 'observation', id: 3, content: 'b1', entityName: 'A1', score: 1 },
    ]
    const r = _rrfMerge([{ hits: a, weight: 1 }, { hits: b, weight: 1.5 }], 5)
    expect(r.length).toBeLessThanOrEqual(3)
  })

  it('respects topK', () => {
    const many: KnowledgeHit[] = Array.from({ length: 20 }, (_, i) => ({
      kind: 'entity' as const,
      id: i,
      content: '' + i,
      entityName: 'e' + i,
      score: 1,
    }))
    expect(_rrfMerge([{ hits: many, weight: 1 }], 5)).toHaveLength(5)
  })

  it('dedupes by kind+id', () => {
    const h: KnowledgeHit = { kind: 'entity', id: 1, content: 'x', entityName: 'x', score: 1 }
    expect(_rrfMerge([{ hits: [h], weight: 1 }, { hits: [h], weight: 1 }], 5)).toHaveLength(1)
  })
})

describe('_formatKnowledgeBlock', () => {
  it('empty on no hits', () => expect(_formatKnowledgeBlock([], 1000)).toBe(''))

  it('formats with entity grouping', () => {
    const hits: KnowledgeHit[] = [
      { kind: 'entity', id: 1, content: 'ClaudePaw platform', entityName: 'ClaudePaw', score: 1.5 },
      { kind: 'observation', id: 2, content: 'Runs on Tailscale', entityName: 'ClaudePaw', score: 1.2 },
    ]
    const b = _formatKnowledgeBlock(hits, 1000)
    expect(b).toContain('[Knowledge]')
    expect(b).toContain('ClaudePaw')
    expect(b).toContain('Runs on Tailscale')
  })
})
