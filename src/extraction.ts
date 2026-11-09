import {
  EXTRACTION_PROVIDER,
  EXTRACTION_MODEL,
  EMBEDDING_BASE_URL,
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY,
  MEMORY_ENABLED,
} from './config.js'
import { getDb } from './db.js'
import {
  upsertEntity,
  getEntityByName,
  addObservation,
  closeObservation,
  addRelation,
  getCurrentObservations,
} from './knowledge.js'
import { embedText, storeEmbedding } from './embeddings.js'
import { logger } from './logger.js'

// ── Types ──────────────────────────────────────────────────────────────────

interface ExtractionResult {
  entities: Array<{ name: string; type: string; isNew: boolean; summary: string | null }>
  observations: Array<{ entity: string; fact: string; confidence: number; supersedes: string | null }>
  relations: Array<{ from: string; to: string; type: string }>
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Extract entities, observations, and relations from a conversation turn.
 * Async, never throws -- all failures logged and swallowed.
 * Call this after delivering the agent response to the user.
 */
export async function extractFromConversation(
  userMessage: string,
  agentResponse: string,
  projectId: string | null = null,
): Promise<void> {
  if (!MEMORY_ENABLED) return
  if (userMessage.startsWith('/')) return
  if (agentResponse.length < 20) return

  // Gate bypass protection: the extraction pipeline makes real LLM calls
  // against OpenAI/Anthropic/Ollama without going through runAgent, which
  // means the cost gate and kill switch would otherwise be silently skipped.
  // Check the kill switch here; the cost gate is coarser-grained so we rely
  // on the per-turn agent gate to trip before extraction runs at 100% cap
  // anyway (extraction is secondary to the user response).
  try {
    const { checkKillSwitch } = await import('./cost/kill-switch-client.js')
    const sw = await checkKillSwitch()
    if (sw) {
      logger.warn({ reason: sw.reason }, 'extraction skipped: kill switch tripped')
      return
    }
  } catch (err) {
    logger.warn({ err }, 'extraction kill-switch check failed (fail-closed, skipping)')
    return
  }

  try {
    const db = getDb()
    const entityNames = (
      db.prepare('SELECT name FROM entities LIMIT 100').all() as Array<{ name: string }>
    ).map((r) => r.name)

    const prompt = _buildExtractionPrompt(userMessage, agentResponse, entityNames)
    let result = _parseExtractionResponse(await _callExtractionLLM(prompt) ?? '')

    if (!result) {
      const retryRaw = await _callExtractionLLM(
        prompt + '\n\nIMPORTANT: Respond ONLY with valid JSON. No prose or explanation.',
      )
      result = _parseExtractionResponse(retryRaw ?? '')
      if (!result) return
    }

    await _storeResult(result, projectId)
  } catch (err) {
    logger.warn({ err }, 'extractFromConversation failed silently')
  }
}

// ── Internal (exported for testing) ───────────────────────────────────────

export function _buildExtractionPrompt(
  userMessage: string,
  agentResponse: string,
  existingEntityNames: string[],
): string {
  return `Extract structured knowledge from this conversation exchange.

## Conversation
User: ${userMessage}
Agent: ${agentResponse}

## Existing entities (for deduplication -- use exact names when referring to these)
${existingEntityNames.slice(0, 50).join(', ')}

## Instructions
Extract only concrete, durable facts -- not conversational filler.
Focus on: people, projects, tools, SOPs, decisions, preferences, status updates.

Respond with ONLY this JSON:
{
  "entities": [
    { "name": "string", "type": "person|project|tool|sop|concept|integration", "isNew": boolean, "summary": "string or null" }
  ],
  "observations": [
    { "entity": "entity name", "fact": "concrete fact", "confidence": 0.0-1.0, "supersedes": "old fact text or null" }
  ],
  "relations": [
    { "from": "entity name", "to": "entity name", "type": "owns|collaborates_with|uses|part_of" }
  ]
}

If nothing useful to extract: {"entities":[],"observations":[],"relations":[]}`
}

export function _parseExtractionResponse(raw: string): ExtractionResult | null {
  try {
    const cleaned = raw.replace(/^```json\n?|\n?```$/g, '').trim()
    const parsed = JSON.parse(cleaned)
    if (
      !Array.isArray(parsed.entities) ||
      !Array.isArray(parsed.observations) ||
      !Array.isArray(parsed.relations)
    ) {
      return null
    }
    return parsed as ExtractionResult
  } catch {
    return null
  }
}

async function _storeResult(result: ExtractionResult, projectId: string | null): Promise<void> {
  const db = getDb()

  for (const e of result.entities) {
    if (!e.name?.trim()) continue
    upsertEntity({ name: e.name, type: e.type || 'concept', summary: e.summary ?? null, projectId })
    const entity = getEntityByName(e.name)
    if (entity) {
      const embedding = await embedText(`${e.name}: ${e.summary ?? ''}`)
      storeEmbedding(db, 'entity', entity.id, embedding)
    }
  }

  for (const o of result.observations) {
    if (!o.entity?.trim() || !o.fact?.trim()) continue
    const entity = getEntityByName(o.entity)
    if (!entity) continue

    if (o.supersedes) {
      const match = getCurrentObservations(entity.id).find((obs) =>
        obs.content.toLowerCase().includes(o.supersedes!.toLowerCase().slice(0, 30)),
      )
      if (match) closeObservation(match.id)
    }

    const obsId = addObservation({
      entityId: entity.id,
      content: o.fact,
      source: 'extracted',
      confidence: Math.min(1.0, Math.max(0.0, o.confidence ?? 0.8)),
    })
    const embedding = await embedText(o.fact)
    storeEmbedding(db, 'observation', obsId, embedding)
  }

  for (const r of result.relations) {
    if (!r.from?.trim() || !r.to?.trim()) continue
    const fromEntity = getEntityByName(r.from)
    const toEntity = getEntityByName(r.to)
    if (!fromEntity || !toEntity) continue
    addRelation({
      fromEntityId: fromEntity.id,
      toEntityId: toEntity.id,
      relationType: r.type || 'relates_to',
      fact: `${r.from} ${r.type} ${r.to}`,
    })
  }
}

async function _callExtractionLLM(prompt: string): Promise<string | null> {
  try {
    if (EXTRACTION_PROVIDER === 'ollama') return await _ollamaChat(prompt)
    if (EXTRACTION_PROVIDER === 'openai') return await _openaiChat(prompt)
    if (EXTRACTION_PROVIDER === 'anthropic') return await _anthropicChat(prompt)
    return null
  } catch (err) {
    logger.warn({ err, provider: EXTRACTION_PROVIDER }, 'Extraction LLM call failed')
    return null
  }
}

async function _ollamaChat(prompt: string): Promise<string> {
  const res = await fetch(`${EMBEDDING_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: 'json',
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`Ollama chat HTTP ${res.status}`)
  return ((await res.json()) as { message: { content: string } }).message.content
}

async function _openaiChat(prompt: string): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set')
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`OpenAI chat HTTP ${res.status}`)
  return (
    (await res.json()) as { choices: Array<{ message: { content: string } }> }
  ).choices[0].message.content
}

async function _anthropicChat(prompt: string): Promise<string> {
  const apiKey = ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`Anthropic chat HTTP ${res.status}`)
  return ((await res.json()) as { content: Array<{ text: string }> }).content[0].text
}
