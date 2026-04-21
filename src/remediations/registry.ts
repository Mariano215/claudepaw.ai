// src/remediations/registry.ts
// Registry of all built-in remediations.

import { logger } from '../logger.js'
import type { RemediationDefinition } from './types.js'
import { pawRetryRemediation } from './paw-retry.js'
import { hallucinatingPawRemediation } from './hallucinating-paw.js'
import { costCapPauserRemediation } from './cost-cap-pauser.js'
import { staleApprovalSkipRemediation } from './stale-approval-skip.js'

const registry = new Map<string, RemediationDefinition>()

export function registerRemediation(def: RemediationDefinition): void {
  if (registry.has(def.id)) {
    logger.warn({ id: def.id }, '[remediations] Overwriting existing remediation')
  }
  registry.set(def.id, def)
}

export function getRemediation(id: string): RemediationDefinition | undefined {
  return registry.get(id)
}

export function listRemediations(): RemediationDefinition[] {
  return Array.from(registry.values()).sort((a, b) => a.id.localeCompare(b.id))
}

// -----------------------------------------------------------------------------
// Built-in registrations
// -----------------------------------------------------------------------------

registerRemediation(pawRetryRemediation)
registerRemediation(hallucinatingPawRemediation)
registerRemediation(costCapPauserRemediation)
registerRemediation(staleApprovalSkipRemediation)
