import { describe, it, expect } from 'vitest'
import { extractDates, extractCommitments, extractDecisions, extractPreferences } from './heuristic.js'

describe('extractDates', () => {
  it('ISO', () => expect(extractDates('launch 2026-05-15')[0].text).toBe('2026-05-15'))
  it('Month Day', () => expect(extractDates('meeting May 15').length).toBeGreaterThan(0))
})

describe('extractCommitments', () => {
  it('I will', () => expect(extractCommitments('I will fix the bug tomorrow.').length).toBe(1))
  it("I'll", () => expect(extractCommitments("I'll get to it by Friday.").length).toBe(1))
  it('none', () => expect(extractCommitments('just a sentence.')).toEqual([]))
})

describe('extractDecisions', () => {
  it("let's", () => expect(extractDecisions("let's go with B.").length).toBe(1))
  it('decision:', () => expect(extractDecisions('decision: use Postgres.').length).toBe(1))
})

describe('extractPreferences', () => {
  it('I prefer', () => expect(extractPreferences('I prefer plain text.').length).toBe(1))
  it('I always', () => expect(extractPreferences('I always commit first.').length).toBe(1))
})
