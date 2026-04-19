// src/paws/project-name.ts
// Tiny, isolated helper so engine code does not need to import the big db module.

type ProjectRow = { id: string; name: string }
type Lookup = (id: string) => ProjectRow | undefined

let overrideLookup: Lookup | undefined

/** Test hook only. Production code must not call this. */
export function __setProjectLookupForTests(fn: Lookup | undefined): void {
  overrideLookup = fn
}

function defaultLookup(id: string): ProjectRow | undefined {
  // Dynamic import so tests that stub the lookup never need a real DB.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getProject } = require('../db.js') as {
    getProject: (id: string) => ProjectRow | undefined
  }
  return getProject(id)
}

/**
 * Resolve a human-friendly project name. The default project always renders
 * as "ClaudePaw". Named projects use their `name` column. Missing rows fall
 * back to the raw projectId so messages never show `undefined`.
 */
export function getProjectName(projectId: string): string {
  if (projectId === 'default') return 'ClaudePaw'
  const lookup = overrideLookup ?? defaultLookup
  const row = lookup(projectId)
  return row?.name ?? projectId
}
