import {
  getActivePatches,
  searchSkills,
  touchSkill,
} from '../db.js'
import { reportMetric } from '../dashboard.js'
import { logger } from '../logger.js'

const FTS_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'it', 'its', 'this', 'that',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them',
])

/**
 * Sanitize text for FTS5 prefix search (same logic as memory.ts).
 * Uses OR between terms so partial keyword matches surface results.
 */
function sanitizeForFts(text: string): string {
  const cleaned = text.replace(/[^a-zA-Z0-9\s]/g, '')
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !FTS_STOP_WORDS.has(w.toLowerCase()))
    .map((w) => `${w}*`)
    .join(' OR ')
}

/**
 * Build a skill context block to inject into the agent prompt.
 *
 * 1. Fetch active patches for this agent (including global patches)
 * 2. FTS search learned_skills against user message (top 3)
 * 3. Bump last_used on matched skills
 * 4. Return formatted block or empty string
 */
export function buildSkillContext(
  agentId: string | null,
  userMessage: string,
): string {
  try {
    // 1. Active patches
    const patches = getActivePatches(agentId)

    // 2. FTS skill search
    const query = sanitizeForFts(userMessage)
    const skills = query.length > 0 ? searchSkills(agentId, query, 3) : []

    // 3. Touch matched skills
    for (const skill of skills) {
      touchSkill(skill.id)
    }

    // 4. Combine and format
    const lines: string[] = []
    for (const p of patches) {
      lines.push(`- ${p.content}`)
    }
    for (const s of skills) {
      lines.push(`- ${s.content}`)
    }

    if (lines.length === 0) return ''

    // Report injection metric
    reportMetric('learning', 'skills_injected', lines.length)

    logger.debug(
      { agentId, patchCount: patches.length, skillCount: skills.length },
      'Skill context built',
    )

    return `[Learned behaviors]\n${lines.join('\n')}`
  } catch (err) {
    logger.error({ err }, 'Failed to build skill context')
    return ''
  }
}
