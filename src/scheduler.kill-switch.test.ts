import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runDueTasks } from './scheduler.js'
import * as killSwitch from './cost/kill-switch-client.js'
import * as db from './db.js'

describe('scheduler kill-switch gate', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('skips all due tasks when switch tripped', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue({ set_at: 1, reason: 'x' })
    const getDueSpy = vi.spyOn(db, 'getDueTasks').mockReturnValue([])
    await runDueTasks(async () => {})
    expect(getDueSpy).not.toHaveBeenCalled()
  })

  it('runs normally when switch clear', async () => {
    vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue(null)
    const getDueSpy = vi.spyOn(db, 'getDueTasks').mockReturnValue([])
    await runDueTasks(async () => {})
    expect(getDueSpy).toHaveBeenCalled()
  })

  // The 03:00 auto-archive window used to run unguarded, so a throw there
  // aborted the whole tick and no due task ran. CI caught it by happening
  // to run at 03:xx UTC.
  it('still runs due tasks when the 03:00 auto-archive throws', async () => {
    vi.useFakeTimers()
    try {
      const at3am = new Date()
      at3am.setHours(3, 30, 0, 0)
      vi.setSystemTime(at3am)
      vi.spyOn(killSwitch, 'checkKillSwitch').mockResolvedValue(null)
      vi.spyOn(db, 'archiveStaleActionItems').mockImplementation(() => {
        throw new Error('Database not initialized — call initDatabase() first')
      })
      const getDueSpy = vi.spyOn(db, 'getDueTasks').mockReturnValue([])
      await runDueTasks(async () => {})
      expect(getDueSpy).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
