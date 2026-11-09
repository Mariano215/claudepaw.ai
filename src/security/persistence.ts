// src/security/persistence.ts
import { randomUUID } from 'node:crypto';
import { initDatabase } from '../db.js';
import { computeScore } from './types.js';
import type {
  Finding,
  FindingStatus,
  Severity,
  ScanRecord,
  ScanTrigger,
  ScoreSnapshot,
} from './types.js';

// ---------------------------------------------------------------------------
// DB handle -- reuse the singleton from initDatabase()
// ---------------------------------------------------------------------------

function getDb() {
  return initDatabase();
}

// ---------------------------------------------------------------------------
// Row <-> Finding helpers
// ---------------------------------------------------------------------------

interface FindingRow {
  id: string;
  scanner_id: string;
  severity: string;
  title: string;
  description: string;
  target: string;
  auto_fixable: number;
  auto_fixed: number;
  fix_description: string | null;
  status: string;
  first_seen: number;
  last_seen: number;
  resolved_at: number | null;
  metadata: string;
}

function rowToFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    scannerId: row.scanner_id,
    severity: row.severity as Severity,
    title: row.title,
    description: row.description,
    target: row.target,
    autoFixable: row.auto_fixable === 1,
    autoFixed: row.auto_fixed === 1,
    fixDescription: row.fix_description ?? undefined,
    status: row.status as FindingStatus,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    resolvedAt: row.resolved_at ?? undefined,
    metadata: JSON.parse(row.metadata || '{}') as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export function upsertFinding(f: Finding): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO security_findings
       (id, scanner_id, severity, title, description, target,
        auto_fixable, auto_fixed, fix_description, status,
        first_seen, last_seen, resolved_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scanner_id, title, target) DO UPDATE SET
       severity     = excluded.severity,
       description  = excluded.description,
       auto_fixable = excluded.auto_fixable,
       auto_fixed   = excluded.auto_fixed,
       fix_description = excluded.fix_description,
       last_seen    = excluded.last_seen,
       metadata     = excluded.metadata,
       status       = CASE
                        WHEN security_findings.status IN ('fixed','false-positive')
                        THEN 'open'
                        ELSE security_findings.status
                      END`,
  ).run(
    f.id,
    f.scannerId,
    f.severity,
    f.title,
    f.description,
    f.target,
    f.autoFixable ? 1 : 0,
    f.autoFixed ? 1 : 0,
    f.fixDescription ?? null,
    f.status,
    f.firstSeen,
    f.lastSeen,
    f.resolvedAt ?? null,
    JSON.stringify(f.metadata),
  );
}

export function upsertFindings(findings: Finding[]): void {
  const db = getDb();
  const tx = db.transaction(() => {
    for (const f of findings) {
      upsertFinding(f);
    }
  });
  tx();
}

export function getOpenFindings(): Finding[] {
  const db = getDb();
  const severityOrder = `CASE severity
    WHEN 'critical' THEN 0
    WHEN 'high'     THEN 1
    WHEN 'medium'   THEN 2
    WHEN 'low'      THEN 3
    WHEN 'info'     THEN 4
    ELSE 5 END`;
  const rows = db
    .prepare(
      `SELECT * FROM security_findings
       WHERE status = 'open'
       ORDER BY ${severityOrder}, last_seen DESC`,
    )
    .all() as FindingRow[];
  return rows.map(rowToFinding);
}

export interface FindingFilters {
  severity?: Severity;
  scannerId?: string;
  status?: FindingStatus;
  limit?: number;
  offset?: number;
}

export function getAllFindings(filters?: FindingFilters): Finding[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters?.severity) {
    clauses.push('severity = ?');
    params.push(filters.severity);
  }
  if (filters?.scannerId) {
    clauses.push('scanner_id = ?');
    params.push(filters.scannerId);
  }
  if (filters?.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters?.limit ?? 100;
  const offset = filters?.offset ?? 0;

  const rows = getDb()
    .prepare(
      `SELECT * FROM security_findings ${where}
       ORDER BY last_seen DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as FindingRow[];
  return rows.map(rowToFinding);
}

export function updateFindingStatus(id: string, status: FindingStatus): void {
  const resolvedAt =
    status === 'fixed' || status === 'false-positive'
      ? Math.floor(Date.now() / 1000)
      : null;
  getDb()
    .prepare(
      `UPDATE security_findings
       SET status = ?, resolved_at = ?
       WHERE id = ?`,
    )
    .run(status, resolvedAt, id);
}

/**
 * Auto-close findings from a previous scan that are no longer reported.
 * Any open finding for (scannerId, target) whose title is NOT in
 * currentTitles gets marked as 'fixed'.
 */
export function markFindingsResolved(
  scannerId: string,
  target: string,
  currentTitles: string[],
): number {
  if (currentTitles.length === 0) {
    // No current findings -- resolve everything for this scanner+target
    const info = getDb()
      .prepare(
        `UPDATE security_findings
         SET status = 'fixed', resolved_at = ?
         WHERE scanner_id = ? AND target = ? AND status = 'open'`,
      )
      .run(Math.floor(Date.now() / 1000), scannerId, target);
    return info.changes;
  }

  const placeholders = currentTitles.map(() => '?').join(',');
  const info = getDb()
    .prepare(
      `UPDATE security_findings
       SET status = 'fixed', resolved_at = ?
       WHERE scanner_id = ? AND target = ? AND status = 'open'
         AND title NOT IN (${placeholders})`,
    )
    .run(
      Math.floor(Date.now() / 1000),
      scannerId,
      target,
      ...currentTitles,
    );
  return info.changes;
}

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

export function recordScan(scan: ScanRecord): void {
  getDb()
    .prepare(
      `INSERT INTO security_scans (id, scanner_id, started_at, duration_ms, findings_count, trigger)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scan.id,
      scan.scannerId,
      scan.startedAt,
      scan.durationMs,
      scan.findingsCount,
      scan.trigger,
    );
}

export function getRecentScans(limit: number = 20): ScanRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT id, scanner_id, started_at, duration_ms, findings_count, trigger
       FROM security_scans
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    scanner_id: string;
    started_at: number;
    duration_ms: number;
    findings_count: number;
    trigger: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    scannerId: r.scanner_id,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    findingsCount: r.findings_count,
    trigger: r.trigger as ScanTrigger,
  }));
}

// ---------------------------------------------------------------------------
// Auto-fix log
// ---------------------------------------------------------------------------

export interface AutoFixEntry {
  id: string;
  findingId: string;
  scannerId: string;
  action: string;
  success: boolean;
  detail: string | null;
  createdAt: number;
}

export function logAutoFix(
  findingId: string,
  scannerId: string,
  action: string,
  success: boolean,
  detail?: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO security_auto_fixes (id, finding_id, scanner_id, action, success, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      findingId,
      scannerId,
      action,
      success ? 1 : 0,
      detail ?? null,
      Math.floor(Date.now() / 1000),
    );
}

export function getAutoFixLog(limit: number = 50): AutoFixEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT id, finding_id, scanner_id, action, success, detail, created_at
       FROM security_auto_fixes
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    finding_id: string;
    scanner_id: string;
    action: string;
    success: number;
    detail: string | null;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    findingId: r.finding_id,
    scannerId: r.scanner_id,
    action: r.action,
    success: r.success === 1,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Score history
// ---------------------------------------------------------------------------

export function snapshotScore(): ScoreSnapshot {
  const openFindings = getOpenFindings();
  const score = computeScore(openFindings);

  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of openFindings) {
    counts[f.severity]++;
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const snapshot: ScoreSnapshot = {
    date: today,
    score,
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
  };

  getDb()
    .prepare(
      `INSERT INTO security_score_history (date, score, critical_count, high_count, medium_count, low_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         score = excluded.score,
         critical_count = excluded.critical_count,
         high_count = excluded.high_count,
         medium_count = excluded.medium_count,
         low_count = excluded.low_count`,
    )
    .run(
      snapshot.date,
      snapshot.score,
      snapshot.criticalCount,
      snapshot.highCount,
      snapshot.mediumCount,
      snapshot.lowCount,
    );

  return snapshot;
}

export function getScoreHistory(days: number = 30): ScoreSnapshot[] {
  const rows = getDb()
    .prepare(
      `SELECT date, score, critical_count, high_count, medium_count, low_count
       FROM security_score_history
       ORDER BY date DESC
       LIMIT ?`,
    )
    .all(days) as Array<{
    date: string;
    score: number;
    critical_count: number;
    high_count: number;
    medium_count: number;
    low_count: number;
  }>;
  return rows.map((r) => ({
    date: r.date,
    score: r.score,
    criticalCount: r.critical_count,
    highCount: r.high_count,
    mediumCount: r.medium_count,
    lowCount: r.low_count,
  }));
}
