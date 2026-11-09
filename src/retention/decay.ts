import { getDb } from '../db.js'
import { logger } from '../logger.js'

/**
 * Lower confidence on all observations whose parent entity has one of the
 * given types. Confidence is never allowed to drop below `floor`.
 * Returns the number of rows touched by the UPDATE.
 */
export function decayObservationsByKind(
  kinds: string[],
  decayFactor: number,
  floor: number,
): number {
  if (kinds.length === 0) return 0
  const placeholders = kinds.map(() => '?').join(',')
  const r = getDb().prepare(`
    UPDATE observations
    SET confidence = MAX(?, confidence * (1 - ?))
    WHERE entity_id IN (SELECT id FROM entities WHERE type IN (${placeholders}))
  `).run(floor, decayFactor, ...kinds)
  return r.changes
}

export const EPISODIC_KINDS = ['event', 'concept']
export const SEMANTIC_KINDS = ['preference', 'decision', 'project', 'person', 'commitment']

/**
 * Daily decay pass. Tiered by entity kind:
 *   - episodic (event, concept): 0.5% decay, floor 0.3
 *   - semantic (preference, decision, project, person, commitment): 0.2% decay, floor 0.5
 *
 * No entities or observations are deleted. Confidence drops but plateaus at
 * the floor so nothing gets erased by natural decay.
 */
export function runDailyDecay(): { episodic: number; semantic: number } {
  const episodic = decayObservationsByKind(EPISODIC_KINDS, 0.005, 0.3)
  const semantic = decayObservationsByKind(SEMANTIC_KINDS, 0.002, 0.5)
  logger.info({ episodic, semantic }, 'daily decay')
  return { episodic, semantic }
}
