import { getServerDb } from './db.js'

export interface KillSwitch {
  set_at: number
  reason: string
  set_by: string | null
}

interface SystemStateRow {
  id: number
  kill_switch_at: number | null
  kill_switch_reason: string | null
  kill_switch_set_by: string | null
  updated_at: number
}

/** Returns the active kill-switch record, or null if no kill-switch is set. */
export function getKillSwitch(): KillSwitch | null {
  const row = getServerDb()
    .prepare('SELECT kill_switch_at, kill_switch_reason, kill_switch_set_by FROM system_state WHERE id = 1')
    .get() as Pick<SystemStateRow, 'kill_switch_at' | 'kill_switch_reason' | 'kill_switch_set_by'> | undefined

  if (!row || row.kill_switch_at === null) return null

  return {
    set_at: row.kill_switch_at,
    reason: row.kill_switch_reason ?? '',
    set_by: row.kill_switch_set_by ?? null,
  }
}

/** Activates the kill-switch with a reason and the identity of who set it. */
export function setKillSwitch(reason: string, setBy: string): void {
  const now = Date.now()
  const result = getServerDb()
    .prepare(
      'UPDATE system_state SET kill_switch_at = ?, kill_switch_reason = ?, kill_switch_set_by = ?, updated_at = ? WHERE id = 1'
    )
    .run(now, reason, setBy, now)
  if (result.changes === 0) {
    throw new Error('system_state singleton row missing - DB not initialized')
  }
}

/** Clears the kill-switch, returning the system to normal operation. */
export function clearKillSwitch(): void {
  const now = Date.now()
  const result = getServerDb()
    .prepare(
      'UPDATE system_state SET kill_switch_at = NULL, kill_switch_reason = NULL, kill_switch_set_by = NULL, updated_at = ? WHERE id = 1'
    )
    .run(now)
  if (result.changes === 0) {
    throw new Error('system_state singleton row missing - DB not initialized')
  }
}
