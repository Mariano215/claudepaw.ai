import { randomUUID } from 'node:crypto'
import {
  insertActionItem,
  insertActionItemEvent,
  updateActionItemFields,
  getActionItem,
  type ActionItem,
  type ActionItemPriority,
  type ActionItemStatus,
} from './db.js'

function syncActionPlanProject(projectId: string): void {
  import('./dashboard.js')
    .then(({ reportActionPlanSnapshot }) => reportActionPlanSnapshot(projectId))
    .catch(() => { /* silent */ })
}

export async function syncActionPlanProjectAsync(projectId: string): Promise<void> {
  try {
    const { reportActionPlanSnapshot } = await import('./dashboard.js')
    await reportActionPlanSnapshot(projectId)
  } catch {
    /* silent -- dashboard may be unreachable */
  }
}

const TERMINAL: ActionItemStatus[] = ['completed', 'rejected', 'archived']
const NON_TERMINAL: ActionItemStatus[] = ['proposed', 'approved', 'in_progress', 'blocked', 'paused']

const TRANSITIONS: Record<ActionItemStatus, ActionItemStatus[]> = {
  proposed:    ['approved', 'rejected', 'paused', 'archived'],
  approved:    ['in_progress', 'completed', 'paused', 'blocked', 'archived'],
  in_progress: ['completed', 'blocked', 'paused', 'archived'],
  blocked:     ['approved', 'in_progress', 'paused', 'rejected', 'archived'],
  paused:      ['approved', 'rejected', 'archived'],
  completed:   ['archived'],
  rejected:    ['archived'],
  archived:    [],
}

export function canTransition(from: ActionItemStatus, to: ActionItemStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function nextStatusFor(action: 'approve', executableByAgent: boolean): ActionItemStatus {
  if (action === 'approve') return executableByAgent ? 'in_progress' : 'approved'
  throw new Error(`unknown action: ${action}`)
}

export function isTerminal(s: ActionItemStatus): boolean { return TERMINAL.includes(s) }
export function isNonTerminal(s: ActionItemStatus): boolean { return NON_TERMINAL.includes(s) }

export interface CreateActionItemInput {
  project_id: string
  title: string
  description?: string
  priority?: ActionItemPriority
  source: string
  proposed_by: string
  assigned_to?: string
  executable_by_agent?: boolean
  parent_id?: string
  target_date?: number
  initial_status?: ActionItemStatus
}

export function createActionItem(input: CreateActionItemInput): string {
  const id = randomUUID()
  const now = Date.now()
  const item: ActionItem = {
    id,
    project_id: input.project_id,
    title: input.title,
    description: input.description ?? null,
    status: input.initial_status ?? 'proposed',
    priority: input.priority ?? 'medium',
    source: input.source,
    proposed_by: input.proposed_by,
    assigned_to: input.assigned_to ?? null,
    executable_by_agent: input.executable_by_agent ? 1 : 0,
    parent_id: input.parent_id ?? null,
    target_date: input.target_date ?? null,
    created_at: now,
    updated_at: now,
    completed_at: null,
    archived_at: null,
    last_run_at: null,
    last_run_result: null,
    last_run_session: null,
  }
  insertActionItem(item)
  insertActionItemEvent({
    id: randomUUID(),
    item_id: id,
    actor: input.proposed_by,
    event_type: 'created',
    old_value: null,
    new_value: item.status,
    created_at: now,
  })
  syncActionPlanProject(input.project_id)
  return id
}

export function getItemOrThrow(id: string): ActionItem {
  const item = getActionItem(id)
  if (!item) throw new Error(`action item not found: ${id}`)
  return item
}

export function transitionActionItem(
  id: string,
  to: ActionItemStatus,
  actor: string,
): void {
  const item = getItemOrThrow(id)
  if (!canTransition(item.status, to)) {
    throw new Error(`illegal transition: ${item.status} -> ${to}`)
  }
  const now = Date.now()
  const fields: Partial<ActionItem> = { status: to }
  if (to === 'completed') fields.completed_at = now
  if (to === 'archived') fields.archived_at = now
  updateActionItemFields(id, fields)
  insertActionItemEvent({
    id: randomUUID(),
    item_id: id,
    actor,
    event_type: 'status_changed',
    old_value: item.status,
    new_value: to,
    created_at: now,
  })
  syncActionPlanProject(item.project_id)
}

export interface ParsedActionItem {
  title: string
  description?: string
  priority?: ActionItemPriority
  executable_by_agent?: boolean
  target_date?: number
}

const VALID_PRIORITIES: ActionItemPriority[] = ['low', 'medium', 'high', 'critical']

export function parseActionItemsFromAgentOutput(text: string): ParsedActionItem[] {
  // Bug C fix: accept any heading level (##, #, ###, etc.)
  const sectionMatch = text.match(/#+\s*Action Items\s*\n([\s\S]*?)(?:\n##|\Z|$)/i)
  if (!sectionMatch) return []
  const body = sectionMatch[1]
  const results: ParsedActionItem[] = []
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const m = line.match(/^-\s*\[\s*\]\s*(.+)$/)
    if (!m) { i++; continue }
    const rawTitle = m[1].trim()
    const item: ParsedActionItem = { title: rawTitle }

    // Bug A fix: greedy .* so we match the LAST (...) block on the line
    const attrMatch = rawTitle.match(/^(.*)\s+\(([^)]+)\)\s*$/)
    if (attrMatch) {
      item.title = attrMatch[1].trim()
      const attrs = attrMatch[2].split(',').map(s => s.trim().toLowerCase())
      for (const a of attrs) {
        // Bug E fix: also accept executable_by_agent and auto as aliases
        if (a === 'executable' || a === 'executable_by_agent' || a === 'auto') {
          item.executable_by_agent = true
        } else if (VALID_PRIORITIES.includes(a as ActionItemPriority)) {
          item.priority = a as ActionItemPriority
        } else if (a.startsWith('due:')) {
          const dateStr = a.slice(4).trim()
          const ts = new Date(dateStr).getTime()
          if (!Number.isNaN(ts)) item.target_date = ts
        }
      }
    }

    // Bug D fix: collect continuation lines as description
    i++
    const descLines: string[] = []
    while (i < lines.length) {
      const next = lines[i]
      // Stop on blank line or next checklist item
      if (next.trim() === '' || /^-\s*\[\s*\]/.test(next)) break
      // Strip leading whitespace and blockquote markers
      descLines.push(next.replace(/^\s*>?\s*/, ''))
      i++
    }
    if (descLines.length > 0) {
      item.description = descLines.join('\n').trim()
    }

    results.push(item)
  }
  return results
}

export function ingestParsedItems(
  parsed: ParsedActionItem[],
  ctx: { project_id: string; source: string; proposed_by: string },
): string[] {
  return parsed.map(p =>
    createActionItem({
      project_id: ctx.project_id,
      title: p.title,
      description: p.description,
      priority: p.priority,
      executable_by_agent: p.executable_by_agent,
      target_date: p.target_date,
      source: ctx.source,
      proposed_by: ctx.proposed_by,
    }),
  )
}
