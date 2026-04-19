// src/paws-cli.ts
import { initDatabase } from './db.js'
import { createPaw, listPaws, pausePaw, resumePaw, deletePaw } from './paws/index.js'

initDatabase()

const [command, ...args] = process.argv.slice(2)

switch (command) {
  case 'create': {
    const [id, name, agentId, cron, projectId, chatId, threshold] = args
    if (!id || !name || !agentId || !cron || !projectId || !chatId) {
      console.error('Usage: create <id> <name> <agent_id> <cron> <project_id> <chat_id> [threshold]')
      process.exit(1)
    }
    const paw = createPaw({
      id,
      project_id: projectId,
      name,
      agent_id: agentId,
      cron,
      config: {
        approval_threshold: parseInt(threshold ?? '4'),
        chat_id: chatId,
        approval_timeout_sec: 300,
      },
    })
    console.log('Created paw:', paw.id, '| next run:', new Date(paw.next_run).toLocaleString())
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
    pausePaw(args[0])
    console.log('Paused:', args[0])
    break
  }
  case 'resume': {
    if (!args[0]) { console.error('Usage: resume <id>'); process.exit(1) }
    resumePaw(args[0])
    console.log('Resumed:', args[0])
    break
  }
  case 'delete': {
    if (!args[0]) { console.error('Usage: delete <id>'); process.exit(1) }
    deletePaw(args[0])
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
