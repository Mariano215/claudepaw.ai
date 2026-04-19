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
})
