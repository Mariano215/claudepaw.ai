/**
 * Resume all paused broker paws and advance next_run to next future cron occurrence.
 *
 * Use this when broker paws get bulk-paused (e.g., after a claude_desktop auth lapse
 * cascades through cycles and the reaper pauses them).
 *
 * Why sqlite3 CLI instead of better-sqlite3? The bot keeps an open connection on
 * store/claudepaw.db (WAL mode). Opening a second better-sqlite3 handle from a
 * helper script causes lock contention and the script hangs. The sqlite3 CLI plays
 * nicer with the running bot, and we only need simple UPDATEs here.
 *
 * Usage:
 *   npx tsx scripts/resume-broker-paws.ts [--dry-run] [--project=broker]
 */
import { execSync } from 'node:child_process'
import cronParser from 'cron-parser'

const CRON_TZ = 'America/New_York'
const dryRun = process.argv.includes('--dry-run')
const projectArg = process.argv.find((a) => a.startsWith('--project='))
const PROJECT = projectArg ? projectArg.split('=')[1] : 'broker'

interface PawRow {
  id: string
  cron: string
  next_run: number
}

function sqlite(query: string): string {
  return execSync(`sqlite3 -separator '|' store/claudepaw.db "${query.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  })
}

function readPausedPaws(): PawRow[] {
  const out = sqlite(
    `SELECT id, cron, next_run FROM paws WHERE project_id='${PROJECT}' AND status='paused' ORDER BY id`,
  ).trim()
  if (!out) return []
  return out.split('\n').map((line) => {
    const [id, cron, nextRun] = line.split('|')
    return { id, cron, next_run: parseInt(nextRun, 10) }
  })
}

const paws = readPausedPaws()
console.log(`Project: ${PROJECT}`)
console.log(`Paused paws: ${paws.length}`)
if (dryRun) console.log('[DRY RUN] No changes will be written')
console.log('')

if (paws.length === 0) {
  console.log('Nothing to do.')
  process.exit(0)
}

let resumed = 0
let failed = 0
const updates: string[] = []

for (const paw of paws) {
  try {
    const newNextRun = cronParser.parseExpression(paw.cron, { tz: CRON_TZ }).next().getTime()
    const oldDate = new Date(paw.next_run).toLocaleString()
    const newDate = new Date(newNextRun).toLocaleString()
    console.log(`  ${paw.id}`)
    console.log(`    cron:       ${paw.cron}`)
    console.log(`    old next:   ${oldDate}`)
    console.log(`    new next:   ${newDate}`)
    updates.push(
      `UPDATE paws SET status='active', next_run=${newNextRun} WHERE id='${paw.id}';`,
    )
    resumed += 1
  } catch (err) {
    console.error(`  FAILED ${paw.id}: ${(err as Error).message}`)
    failed += 1
  }
}

console.log('')
console.log(`Resumed: ${resumed}  Failed: ${failed}`)

if (!dryRun && updates.length > 0) {
  const sql = ['BEGIN;', ...updates, 'COMMIT;'].join('\n')
  execSync(`sqlite3 store/claudepaw.db`, { input: sql })
  console.log('Applied.')
} else if (dryRun) {
  console.log('(no DB writes — re-run without --dry-run to apply)')
}
