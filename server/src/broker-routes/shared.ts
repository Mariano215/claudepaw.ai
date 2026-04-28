/**
 * broker-routes/shared.ts
 *
 * Tiny helpers used across the broker route modules. Paw Broker has no
 * remote engine -- everything is pure DB against the server SQLite. The
 * helpers here exist solely to keep project-scope resolution and the
 * server-DB import out of every handler.
 *
 * Project model: Paw Broker is a single-project domain (project_id='broker')
 * but the same routes still respect req.scope.allowedProjectIds in case
 * future deployments add multiple broker tenants. We default the resolved
 * project_id to 'broker' when the caller omits it but always verify the
 * user has access via req.scope before trusting that default.
 */

import type { Request } from 'express'
import { getServerDb } from '../db.js'

export const DEFAULT_BROKER_PROJECT_ID = 'broker'

/**
 * Resolve the project_id for a broker request.
 *
 * Priority:
 *   1. explicit query.project_id
 *   2. explicit body.project_id
 *   3. DEFAULT_BROKER_PROJECT_ID
 *
 * Returns null when:
 *   - the resolved id is not a string
 *   - the user is not an admin AND the resolved id is not in
 *     req.scope.allowedProjectIds
 *
 * Callers should treat null as "user has no access; respond 404 to avoid
 * leaking the existence of the broker project to outsiders".
 */
export function getProjectId(req: Request): string | null {
  const fromQuery = typeof req.query.project_id === 'string' ? req.query.project_id : null
  const fromBody = typeof req.body?.project_id === 'string' ? req.body.project_id : null
  const pid = fromQuery ?? fromBody ?? DEFAULT_BROKER_PROJECT_ID
  if (!pid) return null

  // Admin bypass -- can read any project.
  if (req.user?.isAdmin) return pid

  const allowed = req.scope?.allowedProjectIds ?? []
  if (!allowed.includes(pid)) return null
  return pid
}

/**
 * Thin wrapper around getServerDb() so route modules don't have to import
 * the full server-db module just to get a handle.
 */
export function serverDb(): ReturnType<typeof getServerDb> {
  return getServerDb()
}
