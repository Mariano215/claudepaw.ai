// src/paws/db.ts
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Paw, PawStatus, PawConfig, PawCycle, PawCycleState, PawFinding } from './types.js'

export function initPawsTables(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paws (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      name        TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      cron        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','waiting_approval')),
      config      TEXT NOT NULL DEFAULT '{}',
      next_run    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paw_cycles (
      id              TEXT PRIMARY KEY,
      paw_id          TEXT NOT NULL REFERENCES paws(id) ON DELETE CASCADE,
      started_at      INTEGER NOT NULL,
      phase           TEXT NOT NULL DEFAULT 'observe',
      state           TEXT NOT NULL DEFAULT '{}',
      findings        TEXT NOT NULL DEFAULT '[]',
      actions_taken   TEXT NOT NULL DEFAULT '[]',
      report          TEXT,
      completed_at    INTEGER,
      error           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_paw_cycles_paw_id ON paw_cycles(paw_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_paws_status ON paws(status, next_run);
  `)
}

interface CreatePawInput {
  id: string
  project_id: string
  name: string
  agent_id: string
  cron: string
  config: PawConfig
}

export function createPaw(db: InstanceType<typeof Database>, input: CreatePawInput): void {
  db.prepare(`
    INSERT INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?)
  `).run(input.id, input.project_id, input.name, input.agent_id, input.cron, JSON.stringify(input.config), Date.now())
}

export function getPaw(db: InstanceType<typeof Database>, id: string): Paw | undefined {
  const row = db.prepare('SELECT * FROM paws WHERE id = ?').get(id) as any
  if (!row) return undefined
  return { ...row, config: JSON.parse(row.config) }
}

export function listPaws(db: InstanceType<typeof Database>, projectId?: string): Paw[] {
  const rows = projectId
    ? db.prepare('SELECT * FROM paws WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as any[]
    : db.prepare('SELECT * FROM paws ORDER BY created_at DESC').all() as any[]
  return rows.map(r => ({ ...r, config: JSON.parse(r.config) }))
}

export function updatePawStatus(db: InstanceType<typeof Database>, id: string, status: PawStatus): void {
  db.prepare('UPDATE paws SET status = ? WHERE id = ?').run(status, id)
}

export function updatePawNextRun(db: InstanceType<typeof Database>, id: string, nextRun: number): void {
  db.prepare('UPDATE paws SET next_run = ? WHERE id = ?').run(nextRun, id)
}

export function deletePaw(db: InstanceType<typeof Database>, id: string): void {
  db.prepare('DELETE FROM paws WHERE id = ?').run(id)
}

export function createCycle(db: InstanceType<typeof Database>, pawId: string): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO paw_cycles (id, paw_id, started_at, phase, state, findings, actions_taken)
    VALUES (?, ?, ?, 'observe', ?, '[]', '[]')
  `).run(id, pawId, Date.now(), JSON.stringify({
    observe_raw: null,
    analysis: null,
    decisions: null,
    approval_requested: false,
    approval_granted: null,
    act_result: null,
  }))
  return id
}

function parseCycleRow(row: any): PawCycle {
  return {
    ...row,
    state: JSON.parse(row.state),
    findings: JSON.parse(row.findings),
    actions_taken: JSON.parse(row.actions_taken),
  }
}

export function getCycle(db: InstanceType<typeof Database>, id: string): PawCycle | undefined {
  const row = db.prepare('SELECT * FROM paw_cycles WHERE id = ?').get(id) as any
  if (!row) return undefined
  return parseCycleRow(row)
}

export function updateCycle(
  db: InstanceType<typeof Database>,
  id: string,
  updates: Partial<Pick<PawCycle, 'phase' | 'state' | 'findings' | 'actions_taken' | 'report' | 'completed_at' | 'error'>>,
): void {
  const sets: string[] = []
  const values: any[] = []

  if (updates.phase !== undefined) { sets.push('phase = ?'); values.push(updates.phase) }
  if (updates.state !== undefined) { sets.push('state = ?'); values.push(JSON.stringify(updates.state)) }
  if (updates.findings !== undefined) { sets.push('findings = ?'); values.push(JSON.stringify(updates.findings)) }
  if (updates.actions_taken !== undefined) { sets.push('actions_taken = ?'); values.push(JSON.stringify(updates.actions_taken)) }
  if (updates.report !== undefined) { sets.push('report = ?'); values.push(updates.report) }
  if (updates.completed_at !== undefined) { sets.push('completed_at = ?'); values.push(updates.completed_at) }
  if (updates.error !== undefined) { sets.push('error = ?'); values.push(updates.error) }

  if (sets.length === 0) return
  values.push(id)
  db.prepare(`UPDATE paw_cycles SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

export function listCycles(db: InstanceType<typeof Database>, pawId: string, limit: number): PawCycle[] {
  const rows = db.prepare('SELECT * FROM paw_cycles WHERE paw_id = ? ORDER BY started_at DESC LIMIT ?').all(pawId, limit) as any[]
  return rows.map(parseCycleRow)
}

export function getLatestCycle(db: InstanceType<typeof Database>, pawId: string): PawCycle | undefined {
  const row = db.prepare('SELECT * FROM paw_cycles WHERE paw_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(pawId) as any
  if (!row) return undefined
  return parseCycleRow(row)
}

export function getDuePaws(db: InstanceType<typeof Database>): Paw[] {
  const rows = db.prepare(`
    SELECT * FROM paws WHERE status = 'active' AND next_run <= ? ORDER BY next_run ASC
  `).all(Date.now()) as any[]
  return rows.map(r => ({ ...r, config: JSON.parse(r.config) }))
}
