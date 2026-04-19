import type Database from 'better-sqlite3'

export type InstalledIntegrationRow = {
  id: number
  project_id: string
  integration_id: string
  status: 'verifying' | 'connected' | 'error' | 'disconnected'
  account: string | null
  last_verified_at: number | null
  last_error: string | null
  installed_at: number
}

let dbHandle: Database.Database | null = null

export function installedStoreInit(db: Database.Database): void {
  dbHandle = db
}

function db(): Database.Database {
  if (!dbHandle) throw new Error('installed-store not initialized')
  return dbHandle
}

export function upsertInstalledIntegration(args: {
  project_id: string
  integration_id: string
  status: InstalledIntegrationRow['status']
  installed_at: number
}): void {
  db().prepare(`
    INSERT INTO installed_integrations (project_id, integration_id, status, installed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, integration_id) DO UPDATE SET
      status = excluded.status
  `).run(args.project_id, args.integration_id, args.status, args.installed_at)
}

export function setInstalledStatus(
  project_id: string,
  integration_id: string,
  status: InstalledIntegrationRow['status'],
  account: string | null,
  last_verified_at: number,
  last_error: string | null,
): void {
  db().prepare(`
    UPDATE installed_integrations
    SET status = ?, account = ?, last_verified_at = ?, last_error = ?
    WHERE project_id = ? AND integration_id = ?
  `).run(status, account, last_verified_at, last_error, project_id, integration_id)
}

export function getInstalledIntegration(project_id: string, integration_id: string): InstalledIntegrationRow | undefined {
  return db().prepare(
    'SELECT * FROM installed_integrations WHERE project_id = ? AND integration_id = ?'
  ).get(project_id, integration_id) as InstalledIntegrationRow | undefined
}

export function listInstalledForProject(project_id: string): InstalledIntegrationRow[] {
  return db().prepare(
    'SELECT * FROM installed_integrations WHERE project_id = ? ORDER BY integration_id'
  ).all(project_id) as InstalledIntegrationRow[]
}

export function deleteInstalledIntegration(project_id: string, integration_id: string): void {
  db().prepare(
    'DELETE FROM installed_integrations WHERE project_id = ? AND integration_id = ?'
  ).run(project_id, integration_id)
}
