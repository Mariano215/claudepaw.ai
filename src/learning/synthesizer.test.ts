import { describe, it, expect } from 'vitest'
import { buildSynthesisPrompt, parseSynthesisResult } from './synthesizer.js'

describe('buildSynthesisPrompt', () => {
  it('formats feedback records into a prompt', () => {
    const feedback = [
      {
        id: 'fb-1',
        chat_id: '123',
        agent_id: 'scout',
        user_message: 'find trends in AI',
        bot_response: 'Here are some general AI trends...',
        feedback_type: 'explicit' as const,
        feedback_note: 'Too vague, I wanted specific YouTube trends',
        created_at: 1000,
        consumed: 0,
      },
      {
        id: 'fb-2',
        chat_id: '123',
        agent_id: 'scout',
        user_message: 'what is trending this week',
        bot_response: 'Many things are trending...',
        feedback_type: 'correction' as const,
        feedback_note: 'actually I meant cybersecurity trends specifically',
        created_at: 2000,
        consumed: 0,
      },
    ]

    const existingSkills = [
      { uuid: 'sk-1', title: 'Be specific', content: 'Always include specific examples' },
    ]

    const prompt = buildSynthesisPrompt('scout', feedback, existingSkills)

    expect(prompt).toContain('scout')
    expect(prompt).toContain('find trends in AI')
    expect(prompt).toContain('Too vague')
    expect(prompt).toContain('cybersecurity trends')
    expect(prompt).toContain('Be specific')
    expect(prompt).toContain('JSON')
  })
})

describe('parseSynthesisResult', () => {
  it('parses valid JSON output', () => {
    const raw = JSON.stringify({
      new_skills: [{ title: 'Trend specificity', content: 'Always ask which domain when user requests trends' }],
      update_skills: [{ uuid: 'sk-1', content: 'Updated content' }],
      skip_ids: ['fb-2'],
    })

    const result = parseSynthesisResult(raw)
    expect(result).not.toBeNull()
    expect(result!.new_skills).toHaveLength(1)
    expect(result!.new_skills[0].title).toBe('Trend specificity')
    expect(result!.update_skills).toHaveLength(1)
    expect(result!.skip_ids).toHaveLength(1)
  })

  it('extracts JSON from markdown code blocks', () => {
    const raw = 'Here is the analysis:\n```json\n{"new_skills":[],"update_skills":[],"skip_ids":["fb-1"]}\n```'
    const result = parseSynthesisResult(raw)
    expect(result).not.toBeNull()
    expect(result!.skip_ids).toEqual(['fb-1'])
  })

  it('returns null for garbage input', () => {
    const result = parseSynthesisResult('this is not JSON at all')
    expect(result).toBeNull()
  })
})
