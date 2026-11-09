import { describe, it, expect, beforeAll, vi } from 'vitest'
import Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// In-memory DB wired up before the module under test is loaded
// ---------------------------------------------------------------------------

let testDb: Database.Database

vi.mock('./db.js', () => ({
  getServerDb: () => testDb,
}))

beforeAll(() => {
  testDb = new Database(':memory:')
  testDb.exec(
    `CREATE TABLE IF NOT EXISTS system_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      kill_switch_at INTEGER,
      kill_switch_reason TEXT,
      kill_switch_set_by TEXT,
      updated_at INTEGER NOT NULL
    );`
  )
  testDb.prepare('INSERT OR IGNORE INTO system_state (id, updated_at) VALUES (1, ?)').run(Date.now())
})

// Import after mock + beforeAll to ensure testDb is set before module init
const { getKillSwitch, setKillSwitch, clearKillSwitch } = await import('./system-state.js')

describe('system-state kill-switch helpers', () => {
  it('getKillSwitch returns null when not set', () => {
    const result = getKillSwitch()
    expect(result).toBeNull()
  })

  it('setKillSwitch stores reason, set_by, and a positive set_at', () => {
    const before = Date.now()
    setKillSwitch('runaway cost', 'admin-user-1')
    const after = Date.now()

    const result = getKillSwitch()
    expect(result).not.toBeNull()
    expect(result!.reason).toBe('runaway cost')
    expect(result!.set_by).toBe('admin-user-1')
    expect(result!.set_at).toBeGreaterThanOrEqual(before)
    expect(result!.set_at).toBeLessThanOrEqual(after)
  })

  it('clearKillSwitch returns null from getKillSwitch after clearing', () => {
    // Ensure it is set first
    setKillSwitch('test reason', 'admin-user-1')
    expect(getKillSwitch()).not.toBeNull()

    clearKillSwitch()
    expect(getKillSwitch()).toBeNull()
  })
})
