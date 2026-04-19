import { getDb } from '../db.js'
import { getUnsummarizedMessages, markMessagesSummarized, type ChatMessage } from '../chat/messages.js'
import { saveChatSummary } from '../chat/summaries.js'
import { upsertEntity } from '../knowledge.js'
import { logger } from '../logger.js'
import { BATCH_EXTRACTION_PROMPT, SUMMARIZATION_PROMPT } from './prompts.js'
import { MEMORY_V2_EXTRACT_NIGHTLY } from '../config.js'
import { runHaikuPrompt } from './run-haiku.js'

export interface ExtractionResult {
  entities: Array<{ kind: string; name: string; summary: string }>
  observations: Array<{ entity_name: string; content: string; occurred_at: number | null }>
  relations: Array<{ from: string; to: string; kind: string }>
}

const EPISODE_GAP_MS = 4 * 60 * 60 * 1000

/**
 * Route Haiku calls through the local claude CLI so they bill against the
 * subscription instead of the paid API. API fallback engages only if the
 * CLI fails (binary missing, timeout, etc).
 */
async function callHaiku(prompt: string, maxTokens: number): Promise<string> {
  return runHaikuPrompt(prompt, {
    model: process.env.HAIKU_MODEL ?? 'claude-haiku-4-5',
    maxTokens,
    apiFallback: true,
  })
}

export async function runNightlyBatch() {
  if (!MEMORY_V2_EXTRACT_NIGHTLY) {
    return { runId: 0, messagesProcessed: 0, entitiesCreated: 0, observationsCreated: 0, summariesCreated: 0, status: 'completed' as const }
  }
  const db = getDb()
  const startedAt = Date.now()
  const runId = Number(db.prepare(`INSERT INTO extraction_runs (run_type, started_at, status) VALUES ('batch_llm', ?, 'running')`).run(startedAt).lastInsertRowid)

  const stats = {
    runId, messagesProcessed: 0, entitiesCreated: 0,
    observationsCreated: 0, summariesCreated: 0,
    status: 'completed' as 'completed' | 'failed',
    error: undefined as string | undefined,
  }

  try {
    const since = startedAt - 24 * 60 * 60 * 1000
    const recent = db.prepare(`SELECT * FROM chat_messages WHERE created_at >= ? ORDER BY chat_id, created_at ASC LIMIT 1000`).all(since) as ChatMessage[]
    const byChat = _groupMessagesByChat(recent)

    for (const [chatId, messages] of byChat) {
      const projectId = messages[0].project_id
      const entityNames = db.prepare(`SELECT name FROM entities WHERE project_id = ? OR project_id IS NULL ORDER BY updated_at DESC LIMIT 50`).all(projectId) as Array<{name:string}>
      const convo = messages.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')
      const prompt = BATCH_EXTRACTION_PROMPT
        .replace('{entity_names}', entityNames.map(e => e.name).join(', ') || '(none)')
        .replace('{messages}', convo.slice(0, 10000))

      const raw = await callHaiku(prompt, 2000)
      const parsed = _parseExtractionResponse(raw)
      const persist = _persistExtractions(parsed, projectId)
      stats.entitiesCreated += persist.entitiesCreated
      stats.observationsCreated += persist.observationsCreated
      stats.messagesProcessed += messages.length
    }

    const stale = getUnsummarizedMessages(Date.now() - 30 * 86400 * 1000, 500)
    const staleByChat = _groupMessagesByChat(stale)
    for (const [chatId, messages] of staleByChat) {
      const episodes = _detectEpisodes(messages, EPISODE_GAP_MS)
      for (const ep of episodes) {
        if (ep.length < 2) continue
        const convo = ep.map(m => `${m.role}: ${m.content}`).join('\n')
        const sumPrompt = SUMMARIZATION_PROMPT
          .replace('{message_count}', String(ep.length))
          .replace('{date_range}', `${new Date(ep[0].created_at).toISOString().slice(0,10)} to ${new Date(ep[ep.length-1].created_at).toISOString().slice(0,10)}`)
          .replace('{messages}', convo.slice(0, 10000))
        const summary = await callHaiku(sumPrompt, 400)
        if (summary) {
          saveChatSummary({
            chatId, projectId: ep[0].project_id,
            periodStart: ep[0].created_at, periodEnd: ep[ep.length-1].created_at,
            messageCount: ep.length, summary,
          })
          markMessagesSummarized(ep.map(m => m.id), Date.now())
          stats.summariesCreated++
        }
      }
    }
  } catch (err) {
    stats.status = 'failed'
    stats.error = err instanceof Error ? err.message : String(err)
  }

  db.prepare(`UPDATE extraction_runs SET finished_at = ?, messages_processed = ?, entities_created = ?, observations_created = ?, summaries_created = ?, status = ?, error = ? WHERE id = ?`)
    .run(Date.now(), stats.messagesProcessed, stats.entitiesCreated, stats.observationsCreated, stats.summariesCreated, stats.status, stats.error ?? null, runId)
  return stats
}

export function _parseExtractionResponse(raw: string): ExtractionResult {
  const empty: ExtractionResult = { entities: [], observations: [], relations: [] }
  if (!raw) return empty
  const t = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try {
    const p = JSON.parse(t)
    return {
      entities: Array.isArray(p.entities) ? p.entities : [],
      observations: Array.isArray(p.observations) ? p.observations : [],
      relations: Array.isArray(p.relations) ? p.relations : [],
    }
  } catch { return empty }
}

export function _groupMessagesByChat(messages: ChatMessage[]): Map<string, ChatMessage[]> {
  const groups = new Map<string, ChatMessage[]>()
  for (const m of messages) {
    const arr = groups.get(m.chat_id) ?? []
    arr.push(m); groups.set(m.chat_id, arr)
  }
  return groups
}

export function _detectEpisodes(messages: ChatMessage[], gapMs: number): ChatMessage[][] {
  if (messages.length === 0) return []
  const sorted = messages.slice().sort((a, b) => a.created_at - b.created_at)
  const episodes: ChatMessage[][] = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].created_at - sorted[i-1].created_at > gapMs) episodes.push([sorted[i]])
    else episodes[episodes.length-1].push(sorted[i])
  }
  return episodes
}

function _persistExtractions(parsed: ExtractionResult, projectId: string) {
  let entities = 0, observations = 0
  const db = getDb(); const now = Date.now()
  for (const e of parsed.entities) {
    try { upsertEntity({ name: e.name, type: e.kind, summary: e.summary, projectId }); entities++ }
    catch (err) { logger.debug({ err, name: e.name }, 'entity upsert') }
  }
  for (const o of parsed.observations) {
    try {
      const row = db.prepare('SELECT id FROM entities WHERE name = ?').get(o.entity_name) as {id:number}|undefined
      if (!row) continue
      db.prepare(`INSERT INTO observations (entity_id, content, valid_from, source, confidence, created_at, occurred_at, project_id)
        VALUES (?, ?, ?, 'batch_llm', 0.85, ?, ?, ?)`).run(row.id, o.content, now, now, o.occurred_at, projectId)
      observations++
    } catch (err) { logger.debug({ err }, 'obs insert') }
  }
  return { entitiesCreated: entities, observationsCreated: observations }
}
