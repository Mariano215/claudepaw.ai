import { upsertEntity } from '../knowledge.js'
import { getDb } from '../db.js'
import { logger } from '../logger.js'

export interface ExtractedDate { text: string; timestamp: number | null }
export interface ExtractedText { text: string }

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

export function extractDates(text: string): ExtractedDate[] {
  const results: ExtractedDate[] = []
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g
  let m: RegExpExecArray | null
  while ((m = iso.exec(text)) !== null) {
    const ts = Date.parse(m[0])
    results.push({ text: m[0], timestamp: isNaN(ts) ? null : ts })
  }
  const mr = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi')
  while ((m = mr.exec(text)) !== null) results.push({ text: m[0], timestamp: null })
  return results
}

export function extractCommitments(text: string): ExtractedText[] {
  const results: ExtractedText[] = []
  const re = /\b(I(?:'ll| will| shall))\b[^.!?]*[.!?]/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) results.push({ text: m[0].trim() })
  return results
}

export function extractDecisions(text: string): ExtractedText[] {
  const results: ExtractedText[] = []
  const patterns = [/\b(let['\u2019]s)\b[^.!?]*[.!?]/gi, /\b(we['\u2019]re going with|we['\u2019]ll go with|decision:)[^.!?]*[.!?]/gi]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) results.push({ text: m[0].trim() })
  }
  return results
}

export function extractPreferences(text: string): ExtractedText[] {
  const results: ExtractedText[] = []
  const re = /\b(I (?:prefer|always|never)|my \w+ is)\b[^.!?]*[.!?]/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) results.push({ text: m[0].trim() })
  return results
}

export interface HeuristicInput {
  chatMessageId: number
  projectId: string
  userId: string | null
  content: string
  role: 'user' | 'assistant'
}

export function runHeuristicExtraction(input: HeuristicInput) {
  const db = getDb()
  const now = Date.now()
  const dates = extractDates(input.content)
  const commitments = extractCommitments(input.content)
  const decisions = extractDecisions(input.content)
  const preferences = extractPreferences(input.content)

  const insertObservation = (entityId: number, content: string, occurredAt: number | null, projectId: string | null) => {
    db.prepare(`
      INSERT INTO observations (entity_id, content, valid_from, source, confidence, created_at, source_id, occurred_at, project_id)
      VALUES (?, ?, ?, 'chat_message', 0.8, ?, ?, ?, ?)
    `).run(entityId, content, now, now, input.chatMessageId, occurredAt, projectId)
  }

  try {
    for (const d of dates) {
      const id = upsertEntity({ name:`event:${d.text}`, type:'event', summary:d.text, projectId: input.projectId })
      insertObservation(id, d.text, d.timestamp, input.projectId)
    }
    for (const c of commitments) {
      const id = upsertEntity({ name:`commitment:${c.text.slice(0,40)}`, type:'commitment', summary:c.text, projectId: input.projectId })
      insertObservation(id, c.text, null, input.projectId)
    }
    for (const d of decisions) {
      const id = upsertEntity({ name:`decision:${d.text.slice(0,40)}`, type:'decision', summary:d.text, projectId: input.projectId })
      insertObservation(id, d.text, null, input.projectId)
    }
    for (const p of preferences) {
      const id = upsertEntity({ name:`preference:${p.text.slice(0,40)}`, type:'preference', summary:p.text, projectId: null })
      insertObservation(id, p.text, null, null)
    }
  } catch (err) { logger.warn({ err }, 'heuristic persist failed') }

  return {
    datesCount: dates.length,
    commitmentsCount: commitments.length,
    decisionsCount: decisions.length,
    preferencesCount: preferences.length,
  }
}
