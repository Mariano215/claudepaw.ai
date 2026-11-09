#!/usr/bin/env node
import { getDb, initDatabase } from '../src/db.js'
import { embedWithRetry } from '../src/embeddings/ollama-enhanced.js'
import { storeEmbedding } from '../src/embeddings.js'
import { logger } from '../src/logger.js'

async function main() {
  initDatabase()
  const db = getDb()

  const ents = db.prepare(`SELECT e.id, e.name, e.summary FROM entities e
    WHERE NOT EXISTS (SELECT 1 FROM vec_embeddings v WHERE v.target_type = 'entity' AND v.target_id = e.id)`).all() as Array<{id:number;name:string;summary:string|null}>
  logger.info({ count: ents.length }, 'backfill entities')
  for (const e of ents) {
    const emb = await embedWithRetry(e.summary ?? e.name)
    if (emb.length > 0) storeEmbedding(db, 'entity', e.id, emb)
  }

  const obs = db.prepare(`SELECT o.id, o.content FROM observations o
    WHERE NOT EXISTS (SELECT 1 FROM vec_embeddings v WHERE v.target_type = 'observation' AND v.target_id = o.id)`).all() as Array<{id:number;content:string}>
  logger.info({ count: obs.length }, 'backfill observations')
  for (const o of obs) {
    const emb = await embedWithRetry(o.content)
    if (emb.length > 0) storeEmbedding(db, 'observation', o.id, emb)
  }

  logger.info('backfill done')
}

main().catch(err => { logger.error({ err }, 'backfill failed'); process.exit(1) })
