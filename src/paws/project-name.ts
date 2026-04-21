// src/paws/project-name.ts
// Tiny, isolated helper so engine code does not need to import the big db module.

import { getProject } from '../db.js'

type ProjectRow = { id: string; name: string }
type Lookup = (id: string) => ProjectRow | undefined

let overrideLookup: Lookup | undefined

/** Test hook only. Production code must not call this. */
export function __setProjectLookupForTests(fn: Lookup | undefined): void {
  overrideLookup = fn
}

function defaultLookup(id: string): ProjectRow | undefined {
  // Previously this used `require('../db.js')` inside the function so tests
  // that stub the lookup never loaded the real DB module. That broke at
  // runtime because the project is ESM and `require` is undefined at module
  // scope, causing OBSERVE to succeed but ANALYZE/DECIDE to crash with
  // "require is not defined" when the engine built an approval card.
  // Tests continue to work because they call __setProjectLookupForTests
  // before hitting this path, so the real getProject import is never invoked.
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
