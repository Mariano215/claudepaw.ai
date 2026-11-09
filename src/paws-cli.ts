// src/paws-cli.ts
import { initDatabase } from './db.js'
import { createPaw, getPaw, listPaws, pausePaw, resumePaw, deletePaw } from './paws/index.js'
import { clampThreshold } from './paws/engine.js'
import { gateScheduleChange } from './policy-gates.js'

initDatabase()

const [command, ...args] = process.argv.slice(2)

async function main(): Promise<void> {
  switch (command) {
    case 'create': {
      const [id, name, agentId, cron, projectId, chatId, threshold] = args
      if (!id || !name || !agentId || !cron || !projectId || !chatId) {
        console.error('Usage: create <id> <name> <agent_id> <cron> <project_id> <chat_id> [threshold]')
        process.exit(1)
      }
      const allowed = await gateScheduleChange(projectId, 'create paw', id, () => {
        createPaw({
          id,
          project_id: projectId,
          name,
          agent_id: agentId,
          cron,
          config: {
            approval_threshold: clampThreshold(threshold ?? 4),
            chat_id: chatId,
            approval_timeout_sec: 300,
          },
        })
      })
      if (!allowed) {
        console.error('Blocked by action policy: schedule.change')
        process.exit(2)
      }
      const paw = getPaw(id)
      console.log('Created paw:', id, '| next run:', paw ? new Date(paw.next_run).toLocaleString() : 'unknown')
      break
    }
    case 'list': {
      const paws = listPaws(args[0])
      if (paws.length === 0) {
        console.log('No paws configured.')
      } else {
        for (const p of paws) {
          console.log(`${p.id} | ${p.name} | ${p.agent_id} | ${p.cron} | ${p.status}`)
        }
      }
      break
    }
    case 'pause': {
      if (!args[0]) { console.error('Usage: pause <id>'); process.exit(1) }
      const paw = getPaw(args[0])
      if (!paw) { console.error('Paw not found:', args[0]); process.exit(1) }
      const allowed = await gateScheduleChange(paw.project_id, 'pause paw', args[0], () => { pausePaw(args[0]) })
      if (!allowed) {
        console.error('Blocked by action policy: schedule.change')
        process.exit(2)
      }
      console.log('Paused:', args[0])
      break
    }
    case 'resume': {
      if (!args[0]) { console.error('Usage: resume <id>'); process.exit(1) }
      const paw = getPaw(args[0])
      if (!paw) { console.error('Paw not found:', args[0]); process.exit(1) }
      const allowed = await gateScheduleChange(paw.project_id, 'resume paw', args[0], () => { resumePaw(args[0]) })
      if (!allowed) {
        console.error('Blocked by action policy: schedule.change')
        process.exit(2)
      }
      console.log('Resumed:', args[0])
      break
    }
    case 'delete': {
      if (!args[0]) { console.error('Usage: delete <id>'); process.exit(1) }
      const paw = getPaw(args[0])
      if (!paw) { console.error('Paw not found:', args[0]); process.exit(1) }
      const allowed = await gateScheduleChange(paw.project_id, 'delete paw', args[0], () => { deletePaw(args[0]) })
      if (!allowed) {
        console.error('Blocked by action policy: schedule.change')
        process.exit(2)
      }
      console.log('Deleted:', args[0])
      break
    }
    default:
      console.log('Usage: paws <create|list|pause|resume|delete>')
      console.log('  create <id> <name> <agent_id> <cron> <project_id> <chat_id> [threshold]')
      console.log('  list [project_id]')
      console.log('  pause <id>')
      console.log('  resume <id>')
      console.log('  delete <id>')
  }
}

await main()
