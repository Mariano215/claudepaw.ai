#!/usr/bin/env tsx
/**
 * One-shot CLI: prepare an edition (fresh-fetch or replay-snapshot) and
 * publish it to the LinkedIn Newsletter.
 *
 * Env flags:
 *   LINKEDIN_DRY_RUN=true     Save draft only (default). Set to false to actually click Publish.
 *   LINKEDIN_SNAPSHOT_SAVE=1  After fresh-fetch, persist the edition to
 *                              store/newsletter/snapshots/{editionId}.json
 *                              so future runs can replay it without re-fetching.
 *   LINKEDIN_SNAPSHOT_LOAD=<path>  Skip phases 1-7 and replay this snapshot.
 *
 * Examples:
 *   # First time: fresh-fetch + save snapshot + dry-run publish
 *   LINKEDIN_SNAPSHOT_SAVE=1 npm run linkedin:publish-current:dry
 *
 *   # Subsequent iterations: replay the snapshot, dry-run publish
 *   LINKEDIN_SNAPSHOT_LOAD=store/newsletter/snapshots/signal-2026-05-18.json npm run linkedin:publish-current:dry
 *
 *   # Real publish from snapshot
 *   LINKEDIN_DRY_RUN=false LINKEDIN_SNAPSHOT_LOAD=...  npm run linkedin:publish-current
 *
 * Prerequisite: run `npm run linkedin:bootstrap` once to log in.
 */

import { resolve } from 'node:path'
import { generateAndSendNewsletter, initNewsletter } from '../src/newsletter/index.js'
import { ALLOWED_CHAT_ID } from '../src/config.js'
import { logger } from '../src/logger.js'

const DRY_RUN = process.env.LINKEDIN_DRY_RUN !== 'false' // default ON
const SAVE_SNAPSHOT = process.env.LINKEDIN_SNAPSHOT_SAVE === '1'
const LOAD_SNAPSHOT_PATH = process.env.LINKEDIN_SNAPSHOT_LOAD
  ? resolve(process.env.LINKEDIN_SNAPSHOT_LOAD)
  : undefined

async function main() {
  initNewsletter()
  logger.info(
    { dryRun: DRY_RUN, saveSnapshot: SAVE_SNAPSHOT, loadSnapshotPath: LOAD_SNAPSHOT_PATH },
    'LinkedIn one-shot publish starting',
  )

  const sendFn = async (_chatId: string, text: string) => {
    console.log(`\n${text}\n`)
  }

  const summary = await generateAndSendNewsletter(ALLOWED_CHAT_ID, sendFn, {
    skipGmail: true,
    bypassDedup: !LOAD_SNAPSHOT_PATH, // bypass on fresh-fetch; snapshot is already the source of truth
    publishLinkedin: true,
    linkedinDryRun: DRY_RUN,
    saveSnapshot: SAVE_SNAPSHOT,
    loadSnapshotPath: LOAD_SNAPSHOT_PATH,
  })

  logger.info({ summary }, 'LinkedIn one-shot complete')
  console.log(`\n${summary}\n`)
}

main().catch((err) => {
  console.error('LinkedIn publish failed:', err)
  process.exit(1)
})
