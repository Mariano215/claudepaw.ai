#!/usr/bin/env node
import { runNightlyBatch } from '../src/extraction/batch.js'
import { runMonthlyCompaction } from '../src/retention/compact.js'
import { runDailyDecay } from '../src/retention/decay.js'
import { logger } from '../src/logger.js'
import { initDatabase } from '../src/db.js'

const mode = process.argv[2]
async function main() {
  initDatabase()
  if (mode === 'nightly') {
    const batch = await runNightlyBatch()
    const decay = runDailyDecay()
    logger.info({ batch, decay }, 'memory-v2 nightly done')
  } else if (mode === 'compact') {
    const r = runMonthlyCompaction()
    logger.info({ r }, 'memory-v2 compaction done')
  } else {
    console.error('usage: run-memory-v2-nightly.ts nightly|compact')
    process.exit(1)
  }
}
main().catch(err => { logger.error({ err }, 'memory-v2 task failed'); process.exit(1) })
