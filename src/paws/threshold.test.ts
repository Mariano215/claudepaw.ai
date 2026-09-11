import { describe, it, expect } from 'vitest'
import { clampThreshold } from './engine.js'
import { traderPipelineWatchdogConfig } from './trader-pipeline-watchdog.js'
import { coldStartPawConfig } from './trader-coldstart.js'
import { brokerPaws } from './broker-paw-defs.js'

describe('clampThreshold', () => {
  it('reads a value above 5 as 5 so the gate can still fire', () => {
    expect(clampThreshold(6)).toBe(5)
    expect(clampThreshold(99)).toBe(5)
  })
  it('keeps values inside the scale', () => {
    expect(clampThreshold(1)).toBe(1)
    expect(clampThreshold(4)).toBe(4)
    expect(clampThreshold(5)).toBe(5)
  })
  it('floors below 1 and defaults a missing value to 4', () => {
    expect(clampThreshold(0)).toBe(1)
    expect(clampThreshold(-3)).toBe(1)
    expect(clampThreshold(undefined)).toBe(4)
    expect(clampThreshold('nonsense')).toBe(4)
  })
  it('sets read-only reporter paws to the honest maximum of 5, not 6', () => {
    const weeklyDigest = brokerPaws.find(p => p.id === 're-property-weekly-digest')
    expect(traderPipelineWatchdogConfig.approval_threshold).toBe(5)
    expect(coldStartPawConfig.approval_threshold).toBe(5)
    expect(weeklyDigest?.approval_threshold).toBe(5)
  })
})
