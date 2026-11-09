import { describe, it, expect, beforeAll } from 'vitest'
import { buildAgentSlice, type AgentSliceConfig } from './agent-slice.js'
import { createBudget } from './budget.js'
import { initDatabase } from '../db.js'

beforeAll(() => initDatabase())

describe('buildAgentSlice', () => {
  it('empty when no config', async () => {
    expect(await buildAgentSlice(null, 'default', createBudget(1000))).toBe('')
  })
  it('runs queries and returns string', async () => {
    const r = await buildAgentSlice({ social_posts: { statuses: ['draft'], limit: 5 } }, 'default', createBudget(1000))
    expect(typeof r).toBe('string')
  })
  it('ignores unknown keys', async () => {
    const r = await buildAgentSlice({ made_up_table: { limit: 10 } } as unknown as AgentSliceConfig, 'default', createBudget(1000))
    expect(r).toBe('')
  })
})
