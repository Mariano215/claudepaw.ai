import { _parseExtractionResponse, type ExtractionResult } from './batch.js'
import { upsertEntity } from '../knowledge.js'
import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { BATCH_EXTRACTION_PROMPT } from './prompts.js'
import { runHaikuPrompt } from './run-haiku.js'

const SIGNAL_RE = /(^\/remember\b|\bremember:|\bwrite this down\b|\bsave this\b)/i

export function isExplicitRememberSignal(text: string): boolean {
  return SIGNAL_RE.test(text)
}

async function callHaiku(prompt: string, maxTokens: number): Promise<string> {
  return runHaikuPrompt(prompt, {
    model: process.env.HAIKU_MODEL ?? 'claude-haiku-4-5',
    maxTokens,
    apiFallback: true,
  })
}

export async function runRealtimeExtraction(input: { content: string; projectId: string }): Promise<string> {
  const names = getDb().prepare(`SELECT name FROM entities WHERE project_id = ? OR project_id IS NULL ORDER BY updated_at DESC LIMIT 30`).all(input.projectId) as Array<{name:string}>
  const prompt = BATCH_EXTRACTION_PROMPT
    .replace('{entity_names}', names.map(e => e.name).join(', ') || '(none)')
    .replace('{messages}', `User: ${input.content}`)
  const raw = await callHaiku(prompt, 1500)
  const parsed = _parseExtractionResponse(raw)
  return _persistAndSummarize(parsed, input.projectId)
}

function _persistAndSummarize(parsed: ExtractionResult, projectId: string): string {
  const db = getDb(); const now = Date.now(); const summary: string[] = []
  for (const e of parsed.entities) {
    try {
      upsertEntity({ name: e.name, type: e.kind, summary: e.summary, projectId })
      summary.push(`${e.kind}: ${e.name}`)
    } catch (err) {
      logger.debug({ err, entity: e.name }, 'realtime extraction: failed to upsert entity')
    }
  }
  for (const o of parsed.observations) {
    try {
      const row = db.prepare('SELECT id FROM entities WHERE name = ?').get(o.entity_name) as {id:number}|undefined
      if (!row) continue
      db.prepare(`INSERT INTO observations (entity_id, content, valid_from, source, confidence, created_at, occurred_at, project_id)
        VALUES (?, ?, ?, 'realtime_llm', 0.9, ?, ?, ?)`).run(row.id, o.content, now, now, o.occurred_at, projectId)
    } catch (err) {
      logger.debug({ err, entity: o.entity_name }, 'realtime extraction: failed to insert observation')
    }
  }
  return summary.slice(0, 3).join(', ')
}
