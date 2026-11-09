import { getDb } from './db.js'
import { embedText, vecSearch } from './embeddings.js'
import { searchEntities, searchObservations, getCurrentObservations, getEntityById } from './knowledge.js'
import type { Observation } from './knowledge.js'
import { MEMORY_ENABLED } from './config.js'
import { logger } from './logger.js'

// ── Types ──────────────────────────────────────────────────────────────────

export interface KnowledgeHit {
  targetType: 'observation' | 'entity' | 'memory'
  targetId: number
  content: string
  entityName: string
  score: number
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Retrieve relevant knowledge for a user message.
 * Returns formatted context string or empty string on failure.
 */
export async function retrieveKnowledge(
  userMessage: string,
  _projectId: string | null = null,
): Promise<string> {
  if (!MEMORY_ENABLED) return ''
  try {
    const db = getDb()

    const bm25Hits = _bm25Search(userMessage)
    const embedding = await embedText(userMessage)
    const vecHits = _vecSearchToHits(db, embedding)

    // Graph traversal from top entity BM25 hits — with 1.5x boost
    const topEntityIds = bm25Hits
      .filter((h) => h.targetType === 'entity')
      .slice(0, 3)
      .map((h) => h.targetId)
    const graphHits = _graphTraversal(topEntityIds).map((h) => ({ ...h, score: h.score * 1.5 }))

    const merged = _rrfMerge([...bm25Hits, ...graphHits], vecHits, 8)
    return _formatKnowledgeContext(merged)
  } catch (err) {
    logger.warn({ err }, 'retrieveKnowledge failed — returning empty')
    return ''
  }
}

// ── Internal (exported for testing) ───────────────────────────────────────

export function _bm25Search(query: string): KnowledgeHit[] {
  const obsHits = searchObservations(query, 10).map((o, i) => ({
    targetType: 'observation' as const,
    targetId: o.id,
    content: o.content,
    entityName: o.entity_name,
    score: 1 / (1 + i),
  }))
  const entityHits = searchEntities(query, 5).map((e, i) => ({
    targetType: 'entity' as const,
    targetId: e.id,
    content: e.summary ?? e.name,
    entityName: e.name,
    score: 1 / (1 + i),
  }))
  return [...obsHits, ...entityHits]
}

export function _vecSearchToHits(
  db: import('better-sqlite3').Database,
  embedding: number[],
): KnowledgeHit[] {
  const results = vecSearch(db, embedding, 10)
  const hits: KnowledgeHit[] = []
  for (const r of results) {
    try {
      if (r.target_type === 'observation') {
        const obs = db
          .prepare('SELECT o.*, e.name as entity_name FROM observations o JOIN entities e ON e.id = o.entity_id WHERE o.id = ?')
          .get(r.target_id) as (Observation & { entity_name: string }) | undefined
        if (obs) hits.push({ targetType: 'observation', targetId: obs.id, content: obs.content, entityName: obs.entity_name, score: 1 - r.distance })
      } else if (r.target_type === 'entity') {
        const entity = getEntityById(r.target_id)
        if (entity) hits.push({ targetType: 'entity', targetId: entity.id, content: entity.summary ?? entity.name, entityName: entity.name, score: 1 - r.distance })
      }
    } catch { /* skip malformed hits */ }
  }
  return hits
}

export function _graphTraversal(entityIds: number[]): KnowledgeHit[] {
  const hits: KnowledgeHit[] = []
  for (const entityId of entityIds) {
    const entity = getEntityById(entityId)
    if (!entity) continue
    for (const o of getCurrentObservations(entityId)) {
      hits.push({ targetType: 'observation', targetId: o.id, content: o.content, entityName: entity.name, score: 1.0 })
    }
  }
  return hits
}

export function _rrfMerge(listA: KnowledgeHit[], listB: KnowledgeHit[], limit: number): KnowledgeHit[] {
  const scores = new Map<string, { hit: KnowledgeHit; score: number }>()

  const addList = (list: KnowledgeHit[]) => {
    list.forEach((hit, rank) => {
      const rrfScore = 1 / (60 + rank)
      const key = `${hit.targetType}:${hit.targetId}`
      const existing = scores.get(key)
      if (existing) {
        existing.score += rrfScore
      } else {
        scores.set(key, { hit, score: rrfScore })
      }
    })
  }

  addList(listA)
  addList(listB)

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((v) => ({ ...v.hit, score: v.score }))
}

export function _formatKnowledgeContext(hits: KnowledgeHit[]): string {
  if (hits.length === 0) return ''
  const lines = hits.map((h) => `- ${h.entityName}: ${h.content}`)
  return `[Knowledge context]\n${lines.join('\n')}`
}
