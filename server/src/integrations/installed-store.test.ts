import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import {
  installedStoreInit,
  upsertInstalledIntegration,
  getInstalledIntegration,
  listInstalledForProject,
  deleteInstalledIntegration,
  setInstalledStatus,
} from './installed-store.js'

describe('installed-store', () => {
  let db: Database.Database

  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), 'inst-'))
    db = new Database(path.join(dir, 'test.db'))
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY);
      INSERT INTO projects (id) VALUES ('p1');
      CREATE TABLE installed_integrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        integration_id TEXT NOT NULL,
        status TEXT NOT NULL,
        account TEXT,
        last_verified_at INTEGER,
        last_error TEXT,
        installed_at INTEGER NOT NULL,
        UNIQUE(project_id, integration_id)
      );
    `)
    installedStoreInit(db)
  })

  it('upserts and reads back an integration', () => {
    upsertInstalledIntegration({ project_id: 'p1', integration_id: 'stripe', status: 'verifying', installed_at: 1000 })
    const row = getInstalledIntegration('p1', 'stripe')
    expect(row?.status).toBe('verifying')
    expect(row?.installed_at).toBe(1000)
  })

  it('updates status via setInstalledStatus', () => {
    upsertInstalledIntegration({ project_id: 'p1', integration_id: 'stripe', status: 'verifying', installed_at: 1000 })
    setInstalledStatus('p1', 'stripe', 'connected', 'acct@x.com', 2000, null)
    const row = getInstalledIntegration('p1', 'stripe')
    expect(row?.status).toBe('connected')
    expect(row?.account).toBe('acct@x.com')
    expect(row?.last_verified_at).toBe(2000)
    expect(row?.last_error).toBeNull()
  })

  it('lists all integrations for a project', () => {
    upsertInstalledIntegration({ project_id: 'p1', integration_id: 'stripe', status: 'connected', installed_at: 1 })
    upsertInstalledIntegration({ project_id: 'p1', integration_id: 'github', status: 'error', installed_at: 2 })
    const list = listInstalledForProject('p1')
    expect(list.map(r => r.integration_id).sort()).toEqual(['github', 'stripe'])
  })

  it('deletes an integration', () => {
    upsertInstalledIntegration({ project_id: 'p1', integration_id: 'stripe', status: 'connected', installed_at: 1 })
    deleteInstalledIntegration('p1', 'stripe')
    expect(getInstalledIntegration('p1', 'stripe')).toBeUndefined()
  })
})
