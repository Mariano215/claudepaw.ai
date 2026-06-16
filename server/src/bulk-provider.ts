/**
 * Pure selection logic for bulk execution-provider changes across projects.
 *
 * Kept free of DB/IO so it can be unit-tested in isolation. The route layer
 * loads projects, calls selectBulkTargets to decide which projects receive the
 * new provider, then performs the upserts + WebSocket sync to the bot.
 *
 * A "pinned" project (execution_pinned = 1) is excluded from bulk changes
 * unless includePinned is explicitly set. This protects deliberate exceptions
 * (a project intentionally kept on a specific provider) from a blanket flip.
 */

export interface BulkTargetProject {
  id: string
  execution_pinned?: number | null
}

export interface BulkSelection {
  /** Project ids that should receive the new provider. */
  applied: string[]
  /** Pinned project ids that were skipped (excluded by the pin). */
  skippedPinned: string[]
  /** Requested ids that do not exist. */
  skippedUnknown: string[]
}

export interface BulkSelectOptions {
  /** Restrict to these ids. Null/empty means "all known projects". */
  projectIds?: string[] | null
  /** Include pinned projects in the change. Default false. */
  includePinned?: boolean
}

export function selectBulkTargets(
  projects: BulkTargetProject[],
  opts: BulkSelectOptions = {},
): BulkSelection {
  const byId = new Map(projects.map((p) => [p.id, p]))
  const requested = opts.projectIds && opts.projectIds.length > 0
    ? opts.projectIds
    : projects.map((p) => p.id)

  const applied: string[] = []
  const skippedPinned: string[] = []
  const skippedUnknown: string[] = []
  const seen = new Set<string>()

  for (const id of requested) {
    if (seen.has(id)) continue
    seen.add(id)
    const project = byId.get(id)
    if (!project) {
      skippedUnknown.push(id)
      continue
    }
    if (!opts.includePinned && Number(project.execution_pinned) === 1) {
      skippedPinned.push(id)
      continue
    }
    applied.push(id)
  }

  return { applied, skippedPinned, skippedUnknown }
}
