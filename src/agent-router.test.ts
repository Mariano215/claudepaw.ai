// NOTE: tryExplicitCommand, scoreKeywords, shouldTryLlm are private in agent-router.ts.
// These tests exercise them indirectly through routeMessage (the only export).
// If direct unit tests are needed, export those helpers or use a test-only barrel.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSoul } from './souls.js'

// Mock souls module so we don't need to load from disk
vi.mock('./souls.js', () => {
  const fakeSouls: AgentSoul[] = [
    {
      id: 'scout',
      name: 'Scout',
      emoji: '🔭',
      role: 'Trend researcher',
      mode: 'active',
      keywords: ['trend', 'trending', 'research', 'topic', 'video idea'],
      capabilities: [],
      systemPrompt: '',
    },
    {
      id: 'auditor',
      name: 'Auditor',
      emoji: '🛡️',
      role: 'Security analyst',
      mode: 'active',
      keywords: ['security', 'audit', 'scan', 'vulnerability', 'cve'],
      capabilities: [],
      systemPrompt: '',
    },
    {
      id: 'producer',
      name: 'Producer',
      emoji: '🎬',
      role: 'Video producer',
      mode: 'on-demand',
      keywords: ['produce', 'video', 'build video', 'edit video', 'render'],
      capabilities: [],
      systemPrompt: '',
    },
  ]

  return {
    getAllSouls: vi.fn(() => fakeSouls),
    getSoul: vi.fn((id: string) => fakeSouls.find((s) => s.id === id) ?? undefined),
  }
})

// Mock agent (LLM classification) so it never actually calls Claude
vi.mock('./agent.js', () => ({
  runAgent: vi.fn(async () => ({ text: 'none' })),
}))

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { routeMessage } from './agent-router.js'

describe('agent-router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── Explicit commands ──────────────────────────────────────────────

  describe('explicit commands', () => {
    it('/agent scout research AI trends -> explicit route to scout', async () => {
      const result = await routeMessage('/agent scout research AI trends')
      expect(result.agentId).toBe('scout')
      expect(result.confidence).toBe('explicit')
      expect(result.strippedMessage).toBe('research AI trends')
    })

    it('/scout research AI trends -> shorthand explicit route', async () => {
      const result = await routeMessage('/scout research AI trends')
      expect(result.agentId).toBe('scout')
      expect(result.confidence).toBe('explicit')
      expect(result.strippedMessage).toBe('research AI trends')
    })

    it('/auditor scan my servers -> routes to auditor', async () => {
      const result = await routeMessage('/auditor scan my servers')
      expect(result.agentId).toBe('auditor')
      expect(result.confidence).toBe('explicit')
    })

    it('/unknown do something -> falls through (no matching soul)', async () => {
      const result = await routeMessage('/unknown do something')
      // "unknown" is not a soul ID, so it falls through to keyword/default
      expect(result.confidence).not.toBe('explicit')
    })

    it('no command prefix -> not explicit', async () => {
      const result = await routeMessage('just a normal message')
      expect(result.confidence).not.toBe('explicit')
    })
  })

  // ── Keyword scoring ────────────────────────────────────────────────

  describe('keyword matching', () => {
    it('message with soul keyword routes via keyword match', async () => {
      const result = await routeMessage('check the latest security audit results')
      expect(result.agentId).toBe('auditor')
      expect(result.confidence).toBe('keyword')
    })

    it('multiple keywords increase score (security + vulnerability)', async () => {
      const result = await routeMessage('security vulnerability found')
      expect(result.agentId).toBe('auditor')
      expect(result.confidence).toBe('keyword')
    })

    it('multi-word keyword "build video" matches producer', async () => {
      const result = await routeMessage('build video about AI hacking')
      expect(result.agentId).toBe('producer')
      expect(result.confidence).toBe('keyword')
    })

    it('message with trend keyword routes to scout', async () => {
      const result = await routeMessage('find trending topics')
      expect(result.agentId).toBe('scout')
      expect(result.confidence).toBe('keyword')
    })

    it('message with no matching keywords falls to default', async () => {
      const result = await routeMessage('hello')
      expect(result.agentId).toBeNull()
      expect(result.confidence).toBe('default')
    })
  })

  // ── LLM gating (shouldTryLlm) ─────────────────────────────────────

  describe('LLM fallback gating', () => {
    it('short message (< 10 words) with no keywords -> default, no LLM', async () => {
      const result = await routeMessage('hey there')
      expect(result.agentId).toBeNull()
      expect(result.confidence).toBe('default')
    })

    it('question about "you" with no keywords -> default (LLM skipped)', async () => {
      // Starts with question word + "you" as second word -> shouldTryLlm returns false
      const result = await routeMessage('what you think about this')
      expect(result.agentId).toBeNull()
      expect(result.confidence).toBe('default')
    })
  })

  // ── Default fallback ───────────────────────────────────────────────

  describe('default routing', () => {
    it('generic message with no matches returns null agentId', async () => {
      const result = await routeMessage('tell me a joke')
      expect(result.agentId).toBeNull()
      expect(result.confidence).toBe('default')
      expect(result.strippedMessage).toBe('tell me a joke')
    })
  })
})
