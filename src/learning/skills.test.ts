// FIX: Previously called initDatabase() which hit the real production DB.
// Now mocks db functions to use in-memory data, avoiding DB contamination.
//
// For true integration tests, db.ts needs a setDb() function (like social/db.ts
// has setSocialDb) so tests can inject an in-memory database instance.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'

// Mock db functions used by skills.ts
vi.mock('../db.js', () => {
  let patches: Array<{ id: string; agent_id: string | null; feedback_id: string; content: string; created_at: number; expires_at: number }> = []
  let skills: Array<{ id: number; uuid: string; agent_id: string | null; title: string; content: string; source_ids: string; effectiveness: number; created_at: number; last_used: number | null; status: string }> = []
  let nextSkillId = 1

  return {
    initDatabase: vi.fn(),

    savePatch: vi.fn((input: { id: string; agent_id: string | null; feedback_id: string; content: string }) => {
      patches.push({
        ...input,
        created_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 604800,
      })
    }),

    saveSkill: vi.fn((input: { uuid: string; agent_id: string | null; title: string; content: string; source_ids: string[] }) => {
      const id = nextSkillId++
      skills.push({
        id,
        uuid: input.uuid,
        agent_id: input.agent_id ?? null,
        title: input.title,
        content: input.content,
        source_ids: JSON.stringify(input.source_ids),
        effectiveness: 1.0,
        created_at: Math.floor(Date.now() / 1000),
        last_used: null,
        status: 'active',
      })
    }),

    getActivePatches: vi.fn((agentId: string | null) => {
      return patches.filter((p) => p.agent_id === agentId || p.agent_id === null)
    }),

    searchSkills: vi.fn((agentId: string | null, _query: string, limit: number = 3) => {
      // Simple mock: return skills matching agent_id (real FTS not available in mock)
      return skills
        .filter((s) => s.agent_id === agentId || s.agent_id === null)
        .filter((s) => s.status === 'active')
        .slice(0, limit)
    }),

    touchSkill: vi.fn(),

    // Expose reset for beforeEach cleanup
    __reset: () => {
      patches = []
      skills = []
      nextSkillId = 1
    },
  }
})

vi.mock('../dashboard.js', () => ({
  reportMetric: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { buildSkillContext } from './skills.js'
import { savePatch, saveSkill } from '../db.js'

beforeEach(async () => {
  vi.clearAllMocks()
  // Reset mock data stores
  const db = await import('../db.js') as any
  db.__reset()
})

describe('buildSkillContext', () => {
  it('returns empty string for agent with no patches or skills', () => {
    const uniqueAgent = 'nonexistent-agent-' + randomUUID()
    const result = buildSkillContext(uniqueAgent, 'xyzzy gibberish foobar')
    expect(result).toBe('')
  })

  it('includes active patches for the agent', () => {
    const agentId = 'scout-test-' + randomUUID().slice(0, 8)
    savePatch({
      id: randomUUID(),
      agent_id: agentId,
      feedback_id: randomUUID(),
      content: 'When handling trend searches: include date ranges',
    })

    const result = buildSkillContext(agentId, 'find trending topics')
    expect(result).toContain('[Learned behaviors]')
    expect(result).toContain('include date ranges')
  })

  it('includes global patches (agent_id is null)', () => {
    savePatch({
      id: randomUUID(),
      agent_id: null,
      feedback_id: randomUUID(),
      content: 'Always confirm before running deploy commands',
    })

    const result = buildSkillContext('builder', 'deploy the app')
    expect(result).toContain('confirm before running deploy')
  })

  it('includes matched skills for the agent', () => {
    const agentId = 'builder-test-' + randomUUID().slice(0, 8)
    saveSkill({
      uuid: randomUUID(),
      agent_id: agentId,
      title: 'Deploy confirmation',
      content: 'Always ask for explicit confirmation before running npm run deploy or npm run restart',
      source_ids: [randomUUID()],
    })

    const result = buildSkillContext(agentId, 'deploy the project')
    expect(result).toContain('explicit confirmation')
  })

  it('does not include patches from other agents', () => {
    const producerAgent = 'producer-test-' + randomUUID().slice(0, 8)
    const builderAgent = 'builder-test-' + randomUUID().slice(0, 8)

    savePatch({
      id: randomUUID(),
      agent_id: producerAgent,
      feedback_id: randomUUID(),
      content: 'This is for producer only',
    })

    // Building context for builder should not include producer patches
    const result = buildSkillContext(builderAgent, 'anything about producing')
    expect(result).not.toContain('This is for producer only')
  })
})
