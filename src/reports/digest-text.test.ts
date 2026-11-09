import { describe, it, expect } from 'vitest'
import { renderDigestText } from './digest-text.js'
import { fixture } from './digest-fixture.js'

const weeklyFixture = { ...fixture, period: { ...fixture.period, hours: 168, label: 'Weekly' } }

describe('renderDigestText', () => {
  const text = renderDigestText(fixture)
  const weeklyText = renderDigestText(weeklyFixture)

  it('puts the sections in the spec order on the weekly digest', () => {
    const order = ['Needs you', 'Handled without you', 'This week', 'Spend', 'Failures']
      .map(h => weeklyText.indexOf(h))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('keeps the remaining sections in order on the daily digest, with no This week (C6)', () => {
    expect(text).not.toContain('This week')
    const order = ['Needs you', 'Handled without you', 'Spend', 'Failures'].map(h => text.indexOf(h))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('lists decisions older than 12 hours first, with the age', () => {
    const needs = text.slice(text.indexOf('Needs you'), text.indexOf('Handled without you'))
    expect(needs.indexOf('Retrain regime')).toBeLessThan(needs.indexOf('social.post'))
    expect(needs).toContain('2d')
    expect(needs).toContain('waiting more than 12h')
  })

  it('groups the handled work by project and carries the one-line note', () => {
    expect(text).toContain('trader: 2 routine cycles, 1 cron task ran, 1 card shipped, 1 failure')
    expect(text).toContain('default: 3 cron tasks ran, 2 cards shipped')
  })

  it('is plain text: no markdown, no HTML, no entity codes', () => {
    expect(text).not.toMatch(/<[a-z/][^>]*>/i)
    expect(text).not.toMatch(/&(amp|lt|gt|quot|#\d+);/)
    expect(text).not.toMatch(/\*\*|__|\[[^\]]+\]\(/)
  })

  it('has no em-dash and no en-dash', () => {
    expect(text).not.toMatch(/[–—]/)
  })

  it('says so plainly when nothing is waiting', () => {
    const quiet = renderDigestText({ ...fixture, needs_you: [] })
    expect(quiet).toContain('Nothing is waiting on you.')
  })

  it('says none plainly when there are no failures', () => {
    expect(text).toContain('None.')
  })
})
