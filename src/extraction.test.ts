import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase } from './db.js'
import { _parseExtractionResponse, _buildExtractionPrompt } from './extraction.js'

beforeAll(() => {
  initDatabase()
})

describe('_parseExtractionResponse', () => {
  it('parses valid JSON extraction response', () => {
    const json = JSON.stringify({
      entities: [{ name: 'ExampleApp', type: 'project', isNew: false, summary: 'iOS SSH app' }],
      observations: [{ entity: 'ExampleApp', fact: 'submitted to App Store review', confidence: 0.9, supersedes: null }],
      relations: [],
    })
    const result = _parseExtractionResponse(json)
    expect(result).not.toBeNull()
    expect(result!.entities[0].name).toBe('ExampleApp')
    expect(result!.observations[0].fact).toBe('submitted to App Store review')
  })

  it('strips markdown code fences before parsing', () => {
    const json = '```json\n{"entities":[],"observations":[],"relations":[]}\n```'
    const result = _parseExtractionResponse(json)
    expect(result).not.toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(_parseExtractionResponse('not json at all')).toBeNull()
  })

  it('returns null for JSON missing required arrays', () => {
    expect(_parseExtractionResponse('{"foo": "bar"}')).toBeNull()
  })
})

describe('_buildExtractionPrompt', () => {
  it('includes user message, agent response, and existing entity names', () => {
    const prompt = _buildExtractionPrompt('run the newsletter', 'calling run_task', ['ExampleApp', 'ExampleNotes'])
    expect(prompt).toContain('run the newsletter')
    expect(prompt).toContain('calling run_task')
    expect(prompt).toContain('ExampleApp')
  })
})
