// src/paws/collectors/index.ts
//
// Paws observe-phase collectors.
//
// A collector is a deterministic TypeScript function that gathers raw data
// (gh, web fetch, DB queries, security scans, etc.) and returns structured
// JSON. Collectors run BEFORE the OBSERVE LLM call. The engine stuffs the
// returned data into the observe prompt so the agent only has to analyze,
// not collect.
//
// Why:
//   - Works on every execution provider, not just claude_desktop with tool use
//   - Zero LLM cost for the gathering phase
//   - Cannot hallucinate ("repo not found" when repo exists)
//   - Deterministic and testable
//   - Matches project design principle: "Tools produce raw data, agent reviews"
//
// Adding a new collector:
//   1. Create `src/paws/collectors/my-collector.ts` exporting a `Collector`
//   2. Import + register it here
//   3. Set `observe_collector: 'my-collector'` on the paw config in DB

import { logger } from '../../logger.js'
import { competitiveLandscapeCollector } from './competitive-landscape.js'
import { githubCommunityCollector } from './github-community.js'

export interface CollectorContext {
  pawId: string
  projectId: string
  args?: Record<string, unknown>
}

export interface CollectorResult {
  /** Structured payload -- shape is collector-specific */
  raw_data: unknown
  /** Milliseconds, matches Date.now() convention across ClaudePaw */
  collected_at: number
  /** Name the collector was registered under */
  collector: string
  /** Non-fatal errors during collection (reported but don't abort) */
  errors?: string[]
}

export type Collector = (ctx: CollectorContext) => Promise<CollectorResult>

const collectors = new Map<string, Collector>()

export function registerCollector(name: string, fn: Collector): void {
  if (collectors.has(name)) {
    logger.warn({ name }, '[paws] Collector already registered, overwriting')
  }
  collectors.set(name, fn)
}

export function getCollector(name: string): Collector | undefined {
  return collectors.get(name)
}

export function listCollectors(): string[] {
  return Array.from(collectors.keys()).sort()
}

/**
 * Execute a registered collector with guardrails.
 * Never throws -- failures are captured into the result's `errors` array
 * so the OBSERVE phase can still run and the agent can report the problem.
 */
export async function runCollector(
  name: string,
  ctx: CollectorContext,
): Promise<CollectorResult> {
  const fn = collectors.get(name)
  if (!fn) {
    return {
      raw_data: null,
      collected_at: Date.now(),
      collector: name,
      errors: [`Collector "${name}" is not registered. Known: ${listCollectors().join(', ') || 'none'}`],
    }
  }
  const started = Date.now()
  try {
    const result = await fn(ctx)
    logger.info(
      { collector: name, pawId: ctx.pawId, elapsedMs: Date.now() - started, hasErrors: Boolean(result.errors?.length) },
      '[paws] Collector finished',
    )
    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ err, collector: name, pawId: ctx.pawId }, '[paws] Collector threw')
    return {
      raw_data: null,
      collected_at: Date.now(),
      collector: name,
      errors: [`Collector threw: ${msg}`],
    }
  }
}

// -----------------------------------------------------------------------------
// Built-in collector registry
// -----------------------------------------------------------------------------

registerCollector('github-community', githubCommunityCollector)
registerCollector('competitive-landscape', competitiveLandscapeCollector)
