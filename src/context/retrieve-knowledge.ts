import { getDb } from '../db.js'
import { embedWithRetry } from '../embeddings/ollama-enhanced.js'
import { vecSearch } from '../embeddings.js'
import {
  searchEntitiesByProject,
  searchObservationsByProject,
  getRelatedEntities,
  getEntityById,
} from '../knowledge.js'
import { searchChatMessages } from '../chat/messages.js'
import { type Budget, estimateTokens } from './budget.js'
import { logger } from '../logger.js'
import { MEMORY_V2_EMBEDDINGS } from '../config.js'

export interface KnowledgeHit {
  kind: 'entity' | 'observation' | 'chat'
  id: number
  content: string
  entityName: string
  score: number
}

/**
 * Layer 4 hybrid knowledge retrieval.
 * Combines BM25 (entities + observations), one-hop graph expansion, optional
 * vector search, and chat FTS. Sources are merged via reciprocal rank fusion
 * with per-source weights, then formatted into a bounded [Knowledge] block.
 */
export async function retrieveKnowledge(input: {
  query: string
  projectId: string
  userId: string | null
  budget: Budget
}): Promise<string> {
  const sources: Array<{ hits: KnowledgeHit[]; weight: number }> = []

  // ── BM25 + graph expansion ──────────────────────────────────────────────
  try {
    const entities = searchEntitiesByProject(input.query, input.projectId, 10)
    const observations = searchObservationsByProject(input.query, input.projectId, 15)
    const bm25: KnowledgeHit[] = [
      ...entities.map((e, i) => ({
        kind: 'entity' as const,
        id: e.id,
        content: e.summary ?? e.name,
        entityName: e.name,
        score: 1 / (1 + i),
      })),
      ...observations.map((o, i) => ({
        kind: 'observation' as const,
        id: o.id,
        content: o.content,
        entityName: o.entity_name,
        score: 1 / (1 + i),
      })),
    ]
    sources.push({ hits: bm25, weight: 1.0 })

    const topIds = bm25.filter((h) => h.kind === 'entity').slice(0, 3).map((h) => h.id)
    const graph: KnowledgeHit[] = []
    for (const eid of topIds) {
      const rel = getRelatedEntities(eid)
      rel.forEach((e, i) =>
        graph.push({
          kind: 'entity',
          id: e.id,
          content: e.summary ?? e.name,
          entityName: e.name,
          score: (1 / (1 + i)) * 0.8,
        }),
      )
    }
    sources.push({ hits: graph, weight: 1.5 })
  } catch (err) {
    logger.warn({ err }, 'BM25/graph retrieval failed')
  }

  // ── Vector search (gated by MEMORY_V2_EMBEDDINGS) ───────────────────────
  if (MEMORY_V2_EMBEDDINGS) {
    try {
      const emb = await embedWithRetry(input.query)
      if (emb.length > 0) {
        const vec = vecSearch(getDb(), emb, 15)
        const vecHits: KnowledgeHit[] = []
        for (const v of vec) {
          if (v.target_type === 'entity') {
            const e = getEntityById(v.target_id)
            if (e) {
              vecHits.push({
                kind: 'entity',
                id: e.id,
                content: e.summary ?? e.name,
                entityName: e.name,
                score: 1 / (1 + v.distance),
              })
            }
          } else if (v.target_type === 'observation') {
            const row = getDb()
              .prepare(
                `SELECT o.id, o.content, e.name as entity_name
                 FROM observations o JOIN entities e ON e.id = o.entity_id
                 WHERE o.id = ?`,
              )
              .get(v.target_id) as
              | { id: number; content: string; entity_name: string }
              | undefined
            if (row) {
              vecHits.push({
                kind: 'observation',
                id: row.id,
                content: row.content,
                entityName: row.entity_name,
                score: 1 / (1 + v.distance),
              })
            }
          }
        }
        sources.push({ hits: vecHits, weight: 1.2 })
      }
    } catch (err) {
      logger.warn({ err }, 'vector retrieval failed')
    }
  }

  // ── Chat FTS (last 30 days, scoped to user) ─────────────────────────────
  try {
    const chat = searchChatMessages({
      query: input.query,
      userId: input.userId,
      limit: 5,
      sinceMs: Date.now() - 30 * 86400 * 1000,
    })
    sources.push({
      hits: chat.map((m, i) => ({
        kind: 'chat' as const,
        id: m.id,
        content: m.content.slice(0, 300),
        entityName: m.role === 'user' ? 'You' : 'Assistant',
        score: 1 / (1 + i),
      })),
      weight: 0.8,
    })
  } catch (err) {
    logger.warn({ err }, 'chat FTS failed')
  }

  const merged = _rrfMerge(sources, 8)
  return _formatKnowledgeBlock(merged, input.budget.remaining)
}

/**
 * Reciprocal Rank Fusion across weighted sources. Dedupes by `${kind}:${id}`,
 * summing contributions across sources. Returns the top-K hits by fused score.
 */
export function _rrfMerge(
  sources: Array<{ hits: KnowledgeHit[]; weight: number }>,
  topK: number,
  rrfK = 60,
): KnowledgeHit[] {
  const scores = new Map<string, { hit: KnowledgeHit; score: number }>()
  for (const { hits, weight } of sources) {
    hits.forEach((hit, rank) => {
      const key = `${hit.kind}:${hit.id}`
      const contribution = weight / (rrfK + rank + 1)
      const existing = scores.get(key)
      if (existing) existing.score += contribution
      else scores.set(key, { hit, score: contribution })
    })
  }
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.hit)
}

/**
 * Format merged hits into a bounded [Knowledge] block, grouped by entity.
 * Stops adding groups once the estimated token budget is exhausted.
 */
export function _formatKnowledgeBlock(hits: KnowledgeHit[], budgetTokens: number): string {
  if (hits.length === 0) return ''
  const grouped = new Map<string, KnowledgeHit[]>()
  for (const h of hits) {
    const arr = grouped.get(h.entityName) ?? []
    arr.push(h)
    grouped.set(h.entityName, arr)
  }
  const parts = ['[Knowledge]']
  let remaining = budgetTokens - estimateTokens(parts[0])
  for (const [name, hs] of grouped) {
    const facts = hs.map((h) => `  - ${h.content}`).join('\n')
    const block = `${name}:\n${facts}`
    if (estimateTokens(block) > remaining) break
    parts.push(block)
    remaining -= estimateTokens(block)
  }
  return parts.length > 1 ? parts.join('\n') : ''
}
