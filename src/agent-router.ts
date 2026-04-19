import { getAllSouls, getSoul } from './souls.js'
import type { AgentSoul } from './souls.js'
import { runAgent } from './agent.js'
import { logger } from './logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RouteResult {
  agentId: string | null // null = use main assistant
  confidence: 'explicit' | 'keyword' | 'llm' | 'default'
  strippedMessage: string // message with command prefix removed
}

interface AgentScore {
  agentId: string
  score: number
}

// ---------------------------------------------------------------------------
// Helpers (not exported)
// ---------------------------------------------------------------------------

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Try to parse an explicit command from the message.
 * Matches: /agent <name> <message>  OR  /<name> <message>
 */
function tryExplicitCommand(message: string): RouteResult | null {
  // /agent <name> <rest>
  const agentCmd = /^\/agent\s+(\S+)\s*([\s\S]*)$/i
  const agentMatch = message.match(agentCmd)
  if (agentMatch) {
    const name = agentMatch[1].toLowerCase()
    const rest = (agentMatch[2] ?? '').trim()
    const soul = getSoul(name)
    if (soul) {
      return {
        agentId: soul.id,
        confidence: 'explicit',
        strippedMessage: rest,
      }
    }
    // Name didn't match a loaded soul -- fall through
  }

  // /<name> <rest>  (shorthand)
  const shortCmd = /^\/(\S+)\s*([\s\S]*)$/i
  const shortMatch = message.match(shortCmd)
  if (shortMatch) {
    const name = shortMatch[1].toLowerCase()
    const rest = (shortMatch[2] ?? '').trim()
    const soul = getSoul(name)
    if (soul) {
      return {
        agentId: soul.id,
        confidence: 'explicit',
        strippedMessage: rest,
      }
    }
    // Name didn't match -- fall through to keyword
  }

  // @name <rest>  (mention-style)
  const mentionCmd = /^@(\S+)\s*([\s\S]*)$/i
  const mentionMatch = message.match(mentionCmd)
  if (mentionMatch) {
    const name = mentionMatch[1].toLowerCase()
    const rest = (mentionMatch[2] ?? '').trim()
    const soul = getSoul(name)
    if (soul) {
      return {
        agentId: soul.id,
        confidence: 'explicit',
        strippedMessage: rest,
      }
    }
  }

  return null
}

/**
 * Score each loaded soul's keywords against the message.
 * Multi-word keyword: +2 points. Single-word: +1 point.
 * Word boundary matching (not substring).
 * Returns sorted descending by score, only entries with score >= 1.
 */
function scoreKeywords(message: string, projectSlug?: string): AgentScore[] {
  const lowerMsg = message.toLowerCase()
  const souls = getAllSouls(projectSlug)
  const scores: AgentScore[] = []

  for (const soul of souls) {
    let score = 0

    for (const keyword of soul.keywords) {
      const lowerKw = keyword.toLowerCase()
      const isMultiWord = lowerKw.includes(' ')
      const escaped = escapeRegex(lowerKw)
      // Word boundary: match "trend" in "trend" and "trending" but not "strending"
      const pattern = new RegExp(`\\b${escaped}`, 'i')

      if (pattern.test(lowerMsg)) {
        score += isMultiWord ? 2 : 1
      }
    }

    if (score >= 1) {
      scores.push({ agentId: soul.id, score })
    }
  }

  // Sort descending. Ties: first in load order (stable sort preserves insertion order)
  scores.sort((a, b) => b.score - a.score)
  return scores
}

/**
 * Gating heuristic for LLM fallback:
 * - No keyword match already found
 * - Message > 10 words
 * - Message doesn't start with question word + "claudepaw" / "you"
 */
function shouldTryLlm(message: string): boolean {
  const words = message.trim().split(/\s+/)
  if (words.length <= 10) return false

  // Check if starts with question word + claudepaw/you
  const questionWords = /^(who|what|when|where|why|how|is|are|can|do|does|did|will|would|could|should)\b/i
  if (questionWords.test(message)) {
    const lowerMsg = message.toLowerCase()
    // Check if second word (or early words) contain "claudepaw" or "you"
    if (words.length >= 2) {
      const secondWord = words[1].toLowerCase().replace(/[^a-z]/g, '')
      if (secondWord === 'claudepaw' || secondWord === 'you') {
        return false
      }
    }
  }

  return true
}

/**
 * Classify the message using an LLM one-shot query.
 * Returns a valid agent ID or null.
 */
async function classifyWithLlm(message: string, projectSlug?: string, projectId?: string): Promise<string | null> {
  const souls = getAllSouls(projectSlug)
  if (souls.length === 0) return null

  const agentList = souls
    .map((s: AgentSoul) => `${s.id}: ${s.role}`)
    .join('\n')

  const classificationPrompt = `Given this user message, which agent should handle it? Agents:\n${agentList}\n\nUser message: "${message}"\n\nReply with ONLY the agent ID, or 'none'.`

  try {
    const result = await runAgent(classificationPrompt, undefined, undefined, undefined, undefined, undefined, {
      projectId,
      projectSlug,
    })
    const reply = (result.text ?? '').trim().toLowerCase()

    // Check if the reply is a valid agent ID
    if (reply && reply !== 'none') {
      const soul = getSoul(reply)
      if (soul) return soul.id
    }
  } catch (err) {
    logger.warn({ err }, 'LLM classification failed -- falling to default')
  }

  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function routeMessage(message: string, projectSlug?: string, projectId?: string): Promise<RouteResult> {
  // 1. Explicit command
  const explicit = tryExplicitCommand(message)
  if (explicit) {
    logger.debug({ agentId: explicit.agentId }, 'Route: explicit command')
    return explicit
  }

  // 2. Keyword match
  const keywordScores = scoreKeywords(message, projectSlug)
  if (keywordScores.length > 0) {
    const best = keywordScores[0]
    logger.debug(
      { agentId: best.agentId, score: best.score },
      'Route: keyword match',
    )
    return {
      agentId: best.agentId,
      confidence: 'keyword',
      strippedMessage: message,
    }
  }

  // 3. LLM fallback
  if (shouldTryLlm(message)) {
    logger.debug('Route: attempting LLM classification')
    const llmAgentId = await classifyWithLlm(message, projectSlug, projectId)
    if (llmAgentId) {
      logger.debug({ agentId: llmAgentId }, 'Route: LLM classification')
      return {
        agentId: llmAgentId,
        confidence: 'llm',
        strippedMessage: message,
      }
    }
  }

  // 4. Default
  logger.debug('Route: default (no agent matched)')
  return {
    agentId: null,
    confidence: 'default',
    strippedMessage: message,
  }
}
