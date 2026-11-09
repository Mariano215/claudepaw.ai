// The verdict decides whether a project shows up as worth reviving or retiring,
// so the classification is worth pinning. Note ACTIVE requires recent activity
// AND live automation: a project with routines that stopped firing is DORMANT,
// not ACTIVE, because that is the case the operator needs to see.
import { describe, it, expect } from 'vitest'
import { verdictFor, definedRoutines, type ProjectHealth } from './project-health.js'

const DAY = 86_400_000

function project(over: Partial<ProjectHealth> = {}): ProjectHealth {
  return {
    id: 'p', displayName: 'P', status: 'active', verdict: 'ACTIVE',
    lastActivityAt: null, lastAgentRunAt: null, costUsd30d: 0, monthlyCapUsd: null,
    routines: { seeded: 0, active: 0, definedNotSeeded: [], cycles30d: 0, failed30d: 0 },
    tasks: { total: 0, active: 0, firing30d: 0, failing: 0 },
    actionItems: {}, agentsNeverRun: [], deadIntegrations: [],
    contextFileBytes: 100, issues: [],
    ...over,
  }
}

describe('verdictFor', () => {
  it('is ACTIVE with recent activity and a live routine', () => {
    expect(verdictFor(project({
      lastActivityAt: Date.now() - DAY,
      routines: { seeded: 1, active: 1, definedNotSeeded: [], cycles30d: 4, failed30d: 0 },
    }))).toBe('ACTIVE')
  })

  it('is ACTIVE with recent activity and a live task', () => {
    expect(verdictFor(project({
      lastActivityAt: Date.now() - DAY,
      tasks: { total: 2, active: 2, firing30d: 2, failing: 0 },
    }))).toBe('ACTIVE')
  })

  it('is DORMANT when automation exists but nothing has run recently', () => {
    expect(verdictFor(project({
      lastActivityAt: Date.now() - 90 * DAY,
      routines: { seeded: 3, active: 3, definedNotSeeded: [], cycles30d: 0, failed30d: 0 },
    }))).toBe('DORMANT')
  })

  it('is DORMANT when it ran recently but every routine is paused', () => {
    expect(verdictFor(project({
      lastActivityAt: Date.now() - DAY,
      routines: { seeded: 2, active: 0, definedNotSeeded: [], cycles30d: 0, failed30d: 0 },
    }))).toBe('DORMANT')
  })

  it('is DEAD with no activity and no automation at all', () => {
    expect(verdictFor(project())).toBe('DEAD')
  })

  // Paused is the operator's answer, so it must outrank every other signal,
  // including looking busy.
  it('is PAUSED regardless of activity when the project is paused', () => {
    expect(verdictFor(project({ status: 'paused' }))).toBe('PAUSED')
    expect(verdictFor(project({
      status: 'paused',
      lastActivityAt: Date.now() - DAY,
      routines: { seeded: 2, active: 2, definedNotSeeded: [], cycles30d: 9, failed30d: 0 },
    }))).toBe('PAUSED')
  })
})

describe('definedRoutines', () => {
  it('does not list the three routines deleted in Phase 3', () => {
    const all = [...definedRoutines().values()].flat()
    for (const dead of ['cp-community-triage', 'cp-oss-health', 'cp-competitive-watch']) {
      expect(all).not.toContain(dead)
    }
  })

  it('lists the routines this phase and Phase 3 added', () => {
    const byProject = definedRoutines()
    expect(byProject.get('broker')).toContain('broker-deal-underwriter')
    expect(byProject.get('pawdev')).toContain('paw-dev-cycle')
    expect(byProject.get('example-company')).toContain('fo-festival-tracker')
  })
})
