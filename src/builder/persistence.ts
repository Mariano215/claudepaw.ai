// src/builder/persistence.ts
import { randomUUID } from 'node:crypto';
import { initDatabase } from '../db.js';
import type {
  ArchitectureDecision,
  TechDebtItem,
  Severity,
  TechDebtStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// DB handle -- reuse the singleton from initDatabase()
// ---------------------------------------------------------------------------

function getDb() {
  return initDatabase();
}

// ---------------------------------------------------------------------------
// Table creation
// ---------------------------------------------------------------------------

export function createBuilderTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS architecture_decisions (
      id          TEXT PRIMARY KEY,
      project     TEXT NOT NULL,
      context     TEXT NOT NULL,
      decision    TEXT NOT NULL,
      rationale   TEXT NOT NULL,
      alternatives TEXT DEFAULT '[]',
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_arch_project ON architecture_decisions(project);

    CREATE TABLE IF NOT EXISTS tech_debt (
      id          TEXT PRIMARY KEY,
      project     TEXT NOT NULL,
      title       TEXT NOT NULL,
      description TEXT DEFAULT '',
      severity    TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low')),
      file_path   TEXT,
      status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in-progress','resolved')),
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_debt_project ON tech_debt(project);
    CREATE INDEX IF NOT EXISTS idx_debt_status ON tech_debt(status);
  `);
}

// ---------------------------------------------------------------------------
// Row <-> type helpers
// ---------------------------------------------------------------------------

interface DecisionRow {
  id: string;
  project: string;
  context: string;
  decision: string;
  rationale: string;
  alternatives: string;
  created_at: number;
}

function rowToDecision(row: DecisionRow): ArchitectureDecision {
  return {
    id: row.id,
    project: row.project,
    context: row.context,
    decision: row.decision,
    rationale: row.rationale,
    alternatives: JSON.parse(row.alternatives || '[]') as string[],
    createdAt: row.created_at,
  };
}

interface DebtRow {
  id: string;
  project: string;
  title: string;
  description: string;
  severity: string;
  file_path: string | null;
  status: string;
  created_at: number;
  resolved_at: number | null;
}

function rowToDebt(row: DebtRow): TechDebtItem {
  return {
    id: row.id,
    project: row.project,
    title: row.title,
    description: row.description,
    severity: row.severity as Severity,
    filePath: row.file_path,
    status: row.status as TechDebtStatus,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

// ---------------------------------------------------------------------------
// Architecture Decisions
// ---------------------------------------------------------------------------

export function logDecision(
  project: string,
  context: string,
  decision: string,
  rationale: string,
  alternatives?: string[],
): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO architecture_decisions (id, project, context, decision, rationale, alternatives, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, project, context, decision, rationale, JSON.stringify(alternatives ?? []), Math.floor(Date.now() / 1000));
  return id;
}

export function getDecisions(project?: string, limit: number = 50): ArchitectureDecision[] {
  const db = getDb();
  if (project) {
    const rows = db
      .prepare('SELECT * FROM architecture_decisions WHERE project = ? ORDER BY created_at DESC LIMIT ?')
      .all(project, limit) as DecisionRow[];
    return rows.map(rowToDecision);
  }
  const rows = db
    .prepare('SELECT * FROM architecture_decisions ORDER BY created_at DESC LIMIT ?')
    .all(limit) as DecisionRow[];
  return rows.map(rowToDecision);
}

// ---------------------------------------------------------------------------
// Tech Debt
// ---------------------------------------------------------------------------

export function addTechDebt(
  project: string,
  title: string,
  description: string,
  severity: Severity,
  filePath?: string,
): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO tech_debt (id, project, title, description, severity, file_path, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(id, project, title, description, severity, filePath ?? null, Math.floor(Date.now() / 1000));
  return id;
}

export function getTechDebt(project?: string, status?: TechDebtStatus): TechDebtItem[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (project) {
    clauses.push('project = ?');
    params.push(project);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const severityOrder = `CASE severity
    WHEN 'critical' THEN 0
    WHEN 'high'     THEN 1
    WHEN 'medium'   THEN 2
    WHEN 'low'      THEN 3
    ELSE 4 END`;

  const rows = getDb()
    .prepare(`SELECT * FROM tech_debt ${where} ORDER BY ${severityOrder}, created_at DESC LIMIT 100`)
    .all(...params) as DebtRow[];
  return rows.map(rowToDebt);
}

export function resolveTechDebt(id: string): void {
  getDb()
    .prepare('UPDATE tech_debt SET status = ?, resolved_at = ? WHERE id = ?')
    .run('resolved', Math.floor(Date.now() / 1000), id);
}

export function updateTechDebtStatus(id: string, status: TechDebtStatus): void {
  const resolvedAt = status === 'resolved' ? Math.floor(Date.now() / 1000) : null;
  getDb()
    .prepare('UPDATE tech_debt SET status = ?, resolved_at = ? WHERE id = ?')
    .run(status, resolvedAt, id);
}
