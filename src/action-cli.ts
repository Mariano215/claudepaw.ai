#!/usr/bin/env node
/**
 * action-cli: CLI wrapper agents invoke via Bash to create action items.
 *
 * Usage:
 *   node dist/action-cli.js create --project <id> --title "..." [--description "..."]
 *                                   [--priority low|medium|high|critical]
 *                                   [--executable] [--agent <id>] [--source <name>]
 *                                   [--due YYYY-MM-DD]
 *   node dist/action-cli.js list --project <id> [--status proposed]
 *   node dist/action-cli.js ingest-output --project <id> --agent <id>  (reads stdin)
 */

import {
  createActionItem,
  parseActionItemsFromAgentOutput,
  ingestParsedItems,
  syncActionPlanProjectAsync,
} from './action-items.js'
import { listActionItems, initDatabase } from './db.js'
import type { ActionItemPriority, ActionItemStatus } from './db.js'

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

async function main(): Promise<void> {
  initDatabase()
  const [cmd, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)

  if (cmd === 'create') {
    const projectId = String(args.project || 'default')
    const title = String(args.title || '')
    if (!title) {
      console.error('--title is required')
      process.exit(2)
    }
    const dueStr = args.due as string | undefined
    const targetDate = dueStr ? new Date(dueStr).getTime() : undefined
    const id = createActionItem({
      project_id: projectId,
      title,
      description: args.description as string | undefined,
      priority: (args.priority as ActionItemPriority) || 'medium',
      source: (args.source as string) || 'agent',
      proposed_by: (args.agent as string) || 'agent',
      executable_by_agent: Boolean(args.executable),
      target_date: targetDate && !Number.isNaN(targetDate) ? targetDate : undefined,
    })
    await syncActionPlanProjectAsync(projectId)
    console.log(JSON.stringify({ id }))
    return
  }

  if (cmd === 'list') {
    const items = listActionItems({
      projectId: args.project as string | undefined,
      status: args.status as ActionItemStatus | undefined,
    })
    console.log(JSON.stringify(items, null, 2))
    return
  }

  if (cmd === 'ingest-output') {
    const projectId = String(args.project || 'default')
    await new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = []
      process.stdin.on('data', c => chunks.push(c as Buffer))
      process.stdin.on('error', reject)
      process.stdin.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const parsed = parseActionItemsFromAgentOutput(text)
        const ids = ingestParsedItems(parsed, {
          project_id: projectId,
          source: (args.source as string) || 'agent',
          proposed_by: (args.agent as string) || 'agent',
        })
        syncActionPlanProjectAsync(projectId).then(() => {
          console.log(JSON.stringify({ created: ids.length, ids }))
          resolve()
        }).catch(resolve) // sync failure is non-fatal
      })
    })
    return
  }

  console.error(`unknown command: ${cmd}`)
  console.error('commands: create, list, ingest-output')
  process.exit(2)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
