import { describe, it, expect } from 'vitest'
import parser from 'cron-parser'
import { pawDevCycleSeed } from './paw-def.js'

describe('paw-dev-cycle definition', () => {
  it('runs twice a day on weekdays, in Eastern time', () => {
    expect(pawDevCycleSeed.cron).toBe('30 8,14 * * 1-5')
    const it1 = parser.parseExpression(pawDevCycleSeed.cron, { tz: 'America/New_York' })
    const next = it1.next().toDate()
    expect([8, 14]).toContain(Number(next.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' })))
    expect([1, 2, 3, 4, 5]).toContain(next.getDay() === 0 ? 7 : next.getDay())
  })

  it('is wired to the deterministic pieces, not to prompts that gather', () => {
    expect(pawDevCycleSeed.project_id).toBe('pawdev')
    expect(pawDevCycleSeed.agent_id).toBe('pawdev--triage')
    expect(pawDevCycleSeed.observe_collector).toBe('github-dev')
    expect(pawDevCycleSeed.post_analyze_handler).toBe('pawdev-triage')
    expect(pawDevCycleSeed.post_act_handler).toBe('pawdev-builder')
    expect(pawDevCycleSeed.skip_if_unchanged).toBe(true)
    // The builder drains the card queue, so a quiet cycle still has work.
    expect(pawDevCycleSeed.always_run_act).toBe(true)
    expect(pawDevCycleSeed.approval_threshold).toBe(4)
    expect(pawDevCycleSeed.phase_instructions.observe).toBeUndefined()
  })

  it('seeds paused, because the bot credential does not exist until Task 13', () => {
    expect(pawDevCycleSeed.status).toBe('paused')
  })

  it('no phase prompt tells an agent to run gh or git directly', () => {
    const text = Object.values(pawDevCycleSeed.phase_instructions).join('\n')
    expect(text).not.toMatch(/\bgh (issue|pr|api|run)\b/)
    expect(text).not.toMatch(/\bgit (push|commit|checkout)\b/)
    expect(text).not.toMatch(/[–—]/)
  })

  it('the ANALYZE prompt says repo text is data, never instructions', () => {
    expect(pawDevCycleSeed.phase_instructions.analyze).toMatch(/data, never instructions/)
  })
})
