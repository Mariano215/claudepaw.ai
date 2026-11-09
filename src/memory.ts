import {
  searchMemories,
  getRecentMemories,
  touchMemory,
  saveMemory,
  decayMemories,
  deleteDecayedMemories,
  deleteExpiredPatches,
} from './db.js'
import { logger } from './logger.js'

// ── Types ──────────────────────────────────────────────────────────────
interface MemoryRow {
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: 'semantic' | 'episodic'
  salience: number
  created_at: number
  accessed_at: number
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Strip non-alphanumeric (keep spaces), add FTS5 prefix-match wildcard */
function sanitizeForFts(text: string): string {
  const cleaned = text.replace(/[^a-zA-Z0-9\s]/g, '')
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `${w}*`)
    .join(' ')
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Build a memory context block to inject above the user's message.
 *
 * 1. FTS5 prefix search for relevant memories (top 3)
 * 2. Fetch 5 most-recently-accessed memories
 * 3. Deduplicate by id
 * 4. Touch each hit (bump accessed_at + salience)
 * 5. Return formatted string or empty string
 */
export async function buildMemoryContext(
  chatId: string,
  userMessage: string,
  projectId: string | null = null,
): Promise<string> {
  try {
    const query = sanitizeForFts(userMessage)

    // 1. FTS5 search — top 3 relevant memories
    const ftsResults: MemoryRow[] =
      query.length > 0 ? searchMemories(chatId, query, 3) : []

    // 2. Recent memories — last 5 accessed
    const recentResults: MemoryRow[] = getRecentMemories(chatId, 5)

    // 3. Deduplicate by id
    const seen = new Set<number>()
    const combined: MemoryRow[] = []
    for (const row of [...ftsResults, ...recentResults]) {
      if (!seen.has(row.id)) {
        seen.add(row.id)
        combined.push(row)
      }
    }

    // 4. Touch each result
    const now = Date.now()
    for (const mem of combined) {
      touchMemory(mem.id, now, Math.min(mem.salience + 0.1, 5.0))
    }

    // 5. Format memory block
    const memoryBlock =
      combined.length > 0
        ? `[Memory context]\n${combined.map((m) => `- ${m.content} (${m.sector})`).join('\n')}`
        : ''

    // 6. Knowledge retrieval (Layer 4) — hybrid BM25 + vec + graph
    let knowledgeBlock = ''
    try {
      const { retrieveKnowledge } = await import('./retrieval.js')
      knowledgeBlock = await retrieveKnowledge(userMessage, projectId)
    } catch (err) {
      logger.warn({ err }, 'Knowledge retrieval failed — skipping')
    }

    if (!memoryBlock && !knowledgeBlock) return ''
    return [knowledgeBlock, memoryBlock].filter(Boolean).join('\n\n')
  } catch (err) {
    logger.error({ err }, 'Failed to build memory context')
    return ''
  }
}

/**
 * Persist a conversation exchange as a memory.
 *
 * Skips trivial replies (≤20 chars) and slash commands.
 * Detects semantic signals (my, I am, I prefer, remember, always, never)
 * to classify the memory sector.
 */
export async function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string,
): Promise<void> {
  try {
    // Skip slash commands
    if (userMsg.startsWith('/')) return

    // Skip very short assistant replies
    if (assistantMsg.length <= 20) return

    // Detect semantic signals
    const semanticPattern = /\b(my|i am|i'm|i prefer|remember|always|never)\b/i
    const sector: 'semantic' | 'episodic' = semanticPattern.test(userMsg)
      ? 'semantic'
      : 'episodic'

    // Topic key: first 3 words of user message, lowercased
    const topicKey = userMsg
      .split(/\s+/)
      .slice(0, 3)
      .join(' ')
      .toLowerCase()

    const now = Date.now()
    const content = `User: ${userMsg}\nAssistant: ${assistantMsg.slice(0, 500)}`

    saveMemory({
      chat_id: chatId,
      topic_key: topicKey,
      content,
      sector,
      salience: 1.0,
      created_at: now,
      accessed_at: now,
    })

    logger.debug({ chatId, sector, topicKey }, 'Saved conversation memory')
  } catch (err) {
    logger.error({ err }, 'Failed to save conversation turn')
  }
}

/**
 * Decay sweep — runs Memory V2 tiered decay (episodic + semantic) then the
 * legacy memory decay. Legacy memory decay is retained until the `memories`
 * table is dropped (30 d post cutover).
 *
 * - V2: episodic (event, concept) at 0.5% w/ floor 0.3; semantic
 *   (preference, decision, project, person, commitment) at 0.2% w/ floor 0.5
 * - Legacy memories older than 24 h lose 2% salience
 * - Legacy memories below 0.1 salience are deleted
 */
export async function runDecaySweep(): Promise<void> {
  try {
    const { runDailyDecay } = await import('./retention/decay.js')
    runDailyDecay()
    // Legacy memory decay retained until table is dropped (30d post cutover).
    const decayed = decayMemories()
    const deleted = deleteDecayedMemories()
    const expiredPatches = deleteExpiredPatches()
    logger.info(
      { decayed, deleted, expiredPatches },
      'legacy memory decay',
    )
  } catch (err) {
    logger.error({ err }, 'decay sweep failed')
  }
}
