// src/remediations/types.ts
//
// Shared types for the remediations engine. A remediation is a deterministic
// auto-fix for a specific class of system problem. Each remediation runs on
// a short cadence, detects whether its trigger condition holds, and if so
// takes action. All runs are logged to the `remediations` table so the daily
// email and dashboard can surface what the system fixed overnight.

export type RemediationTier = 'auto-safe' | 'auto-gated'

export interface RemediationContext {
  /** Milliseconds epoch, same as Date.now() */
  now: number
  /** True when --dry-run, or REMEDIATIONS_DRY_RUN=1 */
  dryRun: boolean
}

export interface RemediationOutcome {
  /** True when the remediation took an action this run */
  acted: boolean
  /** Short human-readable summary ("Retried cp-community-triage cycle X") */
  summary: string
  /** Structured detail for the DB log (JSON-stringified before write) */
  detail?: Record<string, unknown>
  /** Non-fatal errors during execution. Empty or undefined = clean. */
  errors?: string[]
}

export interface RemediationDefinition {
  /** Stable kebab-case identifier stored in the DB */
  id: string
  /** Human-readable name shown in the email + dashboard */
  name: string
  /**
   * auto-safe: reversible, low-blast-radius, always runs.
   * auto-gated: runs, but queues a human approval card instead of applying.
   *             (v1 currently only supports auto-safe; auto-gated is wired
   *              as structure only so we don't have to migrate the table later.)
   */
  tier: RemediationTier
  /** One-sentence explanation for the dashboard */
  description: string
  /** Called once per cadence. Must not throw -- errors go in outcome.errors. */
  run(ctx: RemediationContext): Promise<RemediationOutcome>
}

export interface RemediationLogRow {
  id: number
  remediation_id: string
  started_at: number
  completed_at: number
  acted: 0 | 1
  summary: string
  detail: string | null
  errors: string | null
}
