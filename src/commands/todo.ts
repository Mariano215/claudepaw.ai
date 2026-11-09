import { randomUUID } from 'node:crypto'
import {
  createActionItem,
  transitionActionItem,
  getItemOrThrow,
} from '../action-items.js'
import {
  listActionItems,
  insertActionItemComment,
  insertActionItemEvent,
  updateActionItemFields,
  getProject,
  type ActionItemStatus,
} from '../db.js'

export interface TodoCommandInput {
  args: string
  projectId: string
  actor: string
}

export interface TodoCommandResult {
  ok: boolean
  message: string
  itemId?: string
}

const HELP =
  'Usage: /todo <sub> [args]\n' +
  'Subs: add, list, show, approve, reject, pause, resume, block, complete, assign, comment, archive, move'

function syncActionPlanProject(projectId: string): void {
  import('../dashboard.js')
    .then(({ reportActionPlanSnapshot }) => reportActionPlanSnapshot(projectId))
    .catch(() => { /* silent */ })
}

function splitOnce(s: string): [string, string] {
  const i = s.indexOf(' ')
  if (i < 0) return [s, '']
  return [s.slice(0, i), s.slice(i + 1)]
}

function fmtItem(i: { id: string; title: string; status: string; priority: string }): string {
  return `[${i.status}] ${i.priority} ${i.title}  (${i.id.slice(0, 8)})`
}

export async function handleTodoCommand(input: TodoCommandInput): Promise<TodoCommandResult> {
  const [sub, rest] = splitOnce(input.args.trim())
  switch (sub) {
    case '':
    case 'help':
      return { ok: true, message: HELP }

    case 'add': {
      if (!rest) return { ok: false, message: 'Usage: /todo add <title>' }
      const id = createActionItem({
        project_id: input.projectId,
        title: rest,
        source: input.actor === 'human' ? 'telegram' : input.actor,
        proposed_by: input.actor,
        initial_status: input.actor === 'human' ? 'approved' : 'proposed',
      })
      return { ok: true, message: `Created ${id.slice(0, 8)}: ${rest}`, itemId: id }
    }

    case 'list': {
      const statusArg = rest.trim() || undefined
      const items = listActionItems({
        projectId: input.projectId,
        status: statusArg as ActionItemStatus | undefined,
      })
      if (items.length === 0) return { ok: true, message: 'No action items.' }
      const lines = items.slice(0, 20).map(fmtItem)
      if (items.length > 20) lines.push(`... and ${items.length - 20} more`)
      return { ok: true, message: lines.join('\n') }
    }

    case 'show': {
      const id = rest.trim()
      if (!id) return { ok: false, message: 'Usage: /todo show <id>' }
      const item = getItemOrThrow(id)
      const lines = [
        `Title: ${item.title}`,
        `Status: ${item.status}   Priority: ${item.priority}`,
        `Source: ${item.source}   Proposed by: ${item.proposed_by}`,
        item.assigned_to ? `Assigned: ${item.assigned_to}` : 'Assigned: (none)',
        item.description ? `\n${item.description}` : '',
      ]
      return { ok: true, message: lines.join('\n').trim() }
    }

    case 'approve':
    case 'reject':
    case 'pause':
    case 'resume':
    case 'block':
    case 'complete':
    case 'archive': {
      const [idToken, maybeReason] = splitOnce(rest.trim())
      if (!idToken) return { ok: false, message: `Usage: /todo ${sub} <id> [reason]` }
      const nextMap: Record<string, ActionItemStatus> = {
        approve: 'approved',
        reject: 'rejected',
        pause: 'paused',
        resume: 'approved',
        block: 'blocked',
        complete: 'completed',
        archive: 'archived',
      }
      const next = nextMap[sub]
      transitionActionItem(idToken, next, input.actor)
      if (maybeReason) {
        insertActionItemComment({
          id: randomUUID(),
          item_id: idToken,
          author: input.actor,
          body: maybeReason,
          created_at: Date.now(),
        })
      }
      syncActionPlanProject(input.projectId)
      return { ok: true, message: `${idToken.slice(0, 8)} -> ${next}`, itemId: idToken }
    }

    case 'assign': {
      const [idToken, agent] = splitOnce(rest.trim())
      if (!idToken || !agent) return { ok: false, message: 'Usage: /todo assign <id> <agent>' }
      const prior = getItemOrThrow(idToken)
      updateActionItemFields(idToken, { assigned_to: agent })
      insertActionItemEvent({
        id: randomUUID(),
        item_id: idToken,
        actor: input.actor,
        event_type: 'assigned',
        old_value: prior.assigned_to,
        new_value: agent,
        created_at: Date.now(),
      })
      syncActionPlanProject(input.projectId)
      return { ok: true, message: `${idToken.slice(0, 8)} assigned to ${agent}`, itemId: idToken }
    }

    case 'comment': {
      const [idToken, body] = splitOnce(rest.trim())
      if (!idToken || !body) return { ok: false, message: 'Usage: /todo comment <id> <text>' }
      const now = Date.now()
      insertActionItemComment({
        id: randomUUID(),
        item_id: idToken,
        author: input.actor,
        body,
        created_at: now,
      })
      insertActionItemEvent({
        id: randomUUID(),
        item_id: idToken,
        actor: input.actor,
        event_type: 'commented',
        old_value: null,
        new_value: null,
        created_at: now,
      })
      syncActionPlanProject(input.projectId)
      return { ok: true, message: `Comment added to ${idToken.slice(0, 8)}`, itemId: idToken }
    }

    case 'move': {
      const [idToken, targetProjectId] = splitOnce(rest.trim())
      if (!idToken || !targetProjectId) return { ok: false, message: 'Usage: /todo move <id> <project_id>' }
      const targetProject = getProject(targetProjectId)
      if (!targetProject) return { ok: false, message: `Project not found: ${targetProjectId}` }
      const prior = getItemOrThrow(idToken)
      const oldProjectId = prior.project_id
      if (oldProjectId === targetProjectId) return { ok: false, message: `Item is already in project ${targetProjectId}` }
      updateActionItemFields(idToken, { project_id: targetProjectId })
      insertActionItemEvent({
        id: randomUUID(),
        item_id: idToken,
        actor: input.actor,
        event_type: 'moved',
        old_value: oldProjectId,
        new_value: targetProjectId,
        created_at: Date.now(),
      })
      syncActionPlanProject(oldProjectId)
      syncActionPlanProject(targetProjectId)
      return { ok: true, message: `${idToken.slice(0, 8)} moved from ${oldProjectId} to ${targetProjectId}`, itemId: idToken }
    }

    default:
      return { ok: false, message: HELP }
  }
}
