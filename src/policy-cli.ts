#!/usr/bin/env node
/**
 * policy-cli.ts
 *
 *   node dist/policy-cli.js check <project_id> <action_class> [actor]
 *   node dist/policy-cli.js triage-stale [days]
 *
 * Exit codes for `check`: 0 allow, 2 pending, 3 deny. Wrapper scripts treat
 * anything non-zero as "do not run".
 */
import { initDatabase } from './db.js'
import { checkAction } from './policy.js'
import { triageStaleCards } from './card-runner.js'

async function main(): Promise<void> {
  initDatabase()

  const [command, ...args] = process.argv.slice(2)

  if (command === 'check') {
    const [projectId, actionClass, actor] = args
    if (!projectId || !actionClass) {
      console.error('Usage: policy-cli.js check <project_id> <action_class> [actor]')
      process.exit(1)
    }
    const decision = await checkAction(projectId, actionClass, actor ?? 'shell', { argv: process.argv.slice(2) })
    console.log(decision)
    process.exit(decision === 'allow' ? 0 : decision === 'deny' ? 3 : 2)
  } else if (command === 'triage-stale') {
    const days = Number(args[0] ?? '60') || 60
    const n = triageStaleCards(days * 86_400_000)
    console.log(`rejected ${n} card(s) older than ${days} days`)
  } else {
    console.error('Usage: policy-cli.js check <project_id> <action_class> [actor] | triage-stale [days]')
    process.exit(1)
  }
}

main()
