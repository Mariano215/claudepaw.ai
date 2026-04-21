// src/remediations/runner.ts
//
// Runs all registered remediations. Called from src/index.ts on a 5-min
// interval. Each remediation is wrapped in try/catch so one failure does
// not abort the rest. All runs (acted or not) are logged when acted=true;
// no-op runs are logged too when REMEDIATIONS_LOG_NOOP=1.
//
// For ad-hoc runs use: `node dist/remediations/runner.js`

import { logger } from '../logger.js'
import { readEnvFile } from '../env.js'
import { initDatabase } from '../db.js'
import { initRemediationsSchema, logRemediation } from './db.js'
import { listRemediations } from './registry.js'
import type { RemediationContext } from './types.js'

const env = readEnvFile()
const ENABLED = (env.REMEDIATIONS_ENABLED ?? 'true').toLowerCase() !== 'false'
const DRY_RUN = (env.REMEDIATIONS_DRY_RUN ?? 'false').toLowerCase() === 'true'
const LOG_NOOP = (env.REMEDIATIONS_LOG_NOOP ?? 'false').toLowerCase() === 'true'

export interface RunAllResult {
  /** Remediations that actually did something */
  acted: string[]
  /** Remediations that ran cleanly but took no action */
  noop: string[]
  /** Remediations that threw or returned errors */
  failed: Array<{ id: string; error: string }>
  /** Total wall time in ms */
  durationMs: number
}

export async function runAllRemediations(options: { dryRun?: boolean } = {}): Promise<RunAllResult> {
  const started = Date.now()
  const dryRun = options.dryRun ?? DRY_RUN

  if (!ENABLED) {
    logger.info('[remediations] Disabled via REMEDIATIONS_ENABLED=false')
    return { acted: [], noop: [], failed: [], durationMs: 0 }
  }

  const result: RunAllResult = { acted: [], noop: [], failed: [], durationMs: 0 }

  for (const def of listRemediations()) {
    const runStarted = Date.now()
    const ctx: RemediationContext = { now: runStarted, dryRun }
    try {
      const outcome = await def.run(ctx)
      if (outcome.acted) {
        logRemediation(def.id, runStarted, outcome)
        result.acted.push(def.id)
        logger.info(
          { id: def.id, summary: outcome.summary, dryRun },
          '[remediations] Acted',
        )
      } else {
        if (LOG_NOOP) logRemediation(def.id, runStarted, outcome)
        result.noop.push(def.id)
        logger.debug({ id: def.id, summary: outcome.summary }, '[remediations] No-op')
      }
      if (outcome.errors?.length) {
        logger.warn({ id: def.id, errors: outcome.errors }, '[remediations] Non-fatal errors')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ err, id: def.id }, '[remediations] Threw')
      logRemediation(def.id, runStarted, {
        acted: false,
        summary: `Runtime error: ${msg}`,
        errors: [msg],
      })
      result.failed.push({ id: def.id, error: msg })
    }
  }

  result.durationMs = Date.now() - started
  return result
}

// -----------------------------------------------------------------------------
// CLI entry
// -----------------------------------------------------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}` ||
               process.argv[1]?.endsWith('remediations/runner.js')

if (isMain) {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run') || args.includes('-n')
  initDatabase()
  initRemediationsSchema()
  runAllRemediations({ dryRun })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2))
      process.exit(r.failed.length === 0 ? 0 : 1)
    })
    .catch((err) => {
      console.error(err)
      process.exit(2)
    })
}
