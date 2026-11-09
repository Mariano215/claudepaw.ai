import { getDb } from '../db.js'
import { logger } from '../logger.js'

export function runMonthlyCompaction() {
  const db = getDb()
  const cutoff = Date.now() - 365 * 86400 * 1000
  let deleted = 0, inspected = 0
  const old = db.prepare(`SELECT id, chat_id, created_at FROM chat_messages WHERE created_at < ? ORDER BY chat_id, created_at ASC`).all(cutoff) as Array<{id:number;chat_id:string;created_at:number}>
  for (const m of old) {
    inspected++
    const covered = db.prepare(`SELECT id FROM chat_summaries WHERE chat_id = ? AND period_start <= ? AND period_end >= ? LIMIT 1`).get(m.chat_id, m.created_at, m.created_at) as {id:number}|undefined
    if (!covered) continue
    db.prepare('DELETE FROM chat_messages WHERE id = ?').run(m.id)
    deleted++
  }
  logger.info({ inspected, deleted }, 'monthly compaction')
  return { deleted, inspected }
}
