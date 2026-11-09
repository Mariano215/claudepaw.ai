#!/usr/bin/env tsx
/**
 * One-time seed: ingest MEMORY.md files and knowledge/ directory.
 * Usage: npm run knowledge:seed
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { initDatabase, getDb, initVecTable } from '../src/db.js'
import { upsertEntity, addObservation } from '../src/knowledge.js'
import { embedText, storeEmbedding } from '../src/embeddings.js'
import { EMBEDDING_DIMENSIONS, PROJECT_ROOT } from '../src/config.js'

const MEMORY_DIR = join(homedir(), '.claude/projects/-Volumes-T7-Projects-ClaudePaw/memory')

async function ingestFile(filePath: string, defaultType = 'concept', defaultProject: string | null = null) {
  let content: string
  try {
    content = readFileSync(filePath, 'utf8')
  } catch {
    console.warn(`  [skip] could not read ${filePath}`)
    return
  }
  const db = getDb()

  const titleMatch = content.match(/^#\s+(.+)$/m)
  const typeMatch = content.match(/^type:\s*(.+)$/m)
  const projMatch = content.match(/^project:\s*(.+)$/m)

  const name = titleMatch?.[1]?.trim() ?? filePath.split('/').pop()?.replace('.md', '') ?? 'Unknown'
  const type = typeMatch?.[1]?.trim() ?? defaultType
  const projectId = projMatch?.[1]?.trim() ?? defaultProject

  const entityId = upsertEntity({ name, type, summary: `Seeded from ${filePath.split('/').pop()}`, projectId })
  console.log(`  + ${name} (${type})`)

  const bodyLines = content
    .split('\n')
    .filter((l) => !l.match(/^(type|project):\s*/))
  const sections = bodyLines.join('\n').split(/\n#{1,3}\s+/).filter((s) => s.trim().length > 15)
  let obsCount = 0
  for (const section of sections) {
    const trimmed = section.trim().slice(0, 1000)
    if (!trimmed) continue
    const obsId = addObservation({ entityId, content: trimmed, source: 'authored', confidence: 1.0 })
    try {
      const embedding = await embedText(trimmed.slice(0, 500))
      storeEmbedding(db, 'observation', obsId, embedding)
    } catch {
      // embedding unavailable — observation stored without vector
    }
    obsCount++
  }

  try {
    const entityEmbedding = await embedText(`${name}: ${type}`)
    storeEmbedding(db, 'entity', entityId, entityEmbedding)
  } catch {
    // embedding unavailable — entity stored without vector
  }
  console.log(`    → ${obsCount} observations`)
}

async function main() {
  initDatabase()
  const db = getDb()
  initVecTable(db, EMBEDDING_DIMENSIONS)

  console.log('\n── MEMORY.md files ──')
  if (existsSync(MEMORY_DIR)) {
    const files = readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    for (const file of files) {
      console.log(`\n${file}`)
      await ingestFile(join(MEMORY_DIR, file))
    }
  } else {
    console.log(`Not found: ${MEMORY_DIR}`)
  }

  console.log('\n── knowledge/ directory ──')
  const knowledgeDir = join(PROJECT_ROOT, 'knowledge')
  if (existsSync(knowledgeDir)) {
    const files = readdirSync(knowledgeDir).filter((f) => f.endsWith('.md'))
    for (const file of files) {
      console.log(`\n${file}`)
      await ingestFile(join(knowledgeDir, file))
    }
  } else {
    console.log('No knowledge/ directory found')
  }

  console.log('\n── Seed complete ──')
}

main().catch((err) => { console.error(err); process.exit(1) })
