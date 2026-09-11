// Observe-phase collector for the security patrol routine. Reads open
// findings from security_findings so the LLM only runs when something changed.
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from '../../db.js'
import type { CollectorContext, CollectorResult } from './index.js'

interface Ctx extends CollectorContext { db?: Database.Database }

export async function securityStatusCollector(ctx: Ctx): Promise<CollectorResult> {
  const db = ctx.db ?? getDb()
  const rows = db.prepare(
    `SELECT id, scanner_id, severity, title FROM security_findings WHERE status = 'open' ORDER BY id`,
  ).all() as Array<{ id: string; scanner_id: string; severity: string; title: string }>
  const bySeverity: Record<string, number> = {}
  for (const r of rows) bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1
  const fingerprint = createHash('sha256').update(rows.map(r => `${r.id}:${r.severity}`).join('|')).digest('hex').slice(0, 16)
  return {
    collector: 'security-status',
    collected_at: Date.now(),
    raw_data: { open: rows.length, bySeverity, findings: rows, fingerprint },
  }
}
