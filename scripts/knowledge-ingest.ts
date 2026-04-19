#!/usr/bin/env tsx
/**
 * Ingest a single Markdown file into the knowledge graph.
 * Usage: npm run knowledge:ingest knowledge/newsletter-pipeline.md
 */
import { readFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { initDatabase, getDb, initVecTable } from '../src/db.js'
import { upsertEntity, addObservation } from '../src/knowledge.js'
import { embedText, storeEmbedding } from '../src/embeddings.js'
import { EMBEDDING_DIMENSIONS } from '../src/config.js'

async function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: npm run knowledge:ingest <path-to-markdown>')
    process.exit(1)
  }

  let content: string
  try {
    content = readFileSync(resolve(filePath), 'utf8')
  } catch {
    console.error(`File not found: ${filePath}`)
    process.exit(1)
  }
  const fileName = basename(filePath, '.md')

  initDatabase()
  const db = getDb()
  initVecTable(db, EMBEDDING_DIMENSIONS)

  const titleMatch = content.match(/^#\s+(.+)$/m)
  const typeMatch = content.match(/^type:\s*(.+)$/m)
  const projectMatch = content.match(/^project:\s*(.+)$/m)

  const name = titleMatch?.[1]?.trim() ?? fileName
  const type = typeMatch?.[1]?.trim() ?? 'concept'
  const projectId = projectMatch?.[1]?.trim() ?? null

  const entityId = upsertEntity({ name, type, summary: `Authored: ${name}`, projectId })
  console.log(`Entity: ${name} (id=${entityId}, type=${type}, project=${projectId ?? 'global'})`)

  // Strip frontmatter lines, split on h2/h3 headings
  const bodyLines = content
    .split('\n')
    .filter((l) => !l.match(/^(type|project):\s*/))
  const sections = bodyLines.join('\n').split(/\n#{1,3}\s+/).filter((s) => s.trim().length > 20)

  let obsCount = 0
  for (const section of sections) {
    const trimmed = section.trim().slice(0, 1000)
    if (!trimmed) continue
    const obsId = addObservation({ entityId, content: trimmed, source: 'authored', confidence: 1.0 })
    try {
      const embedding = await embedText(trimmed.slice(0, 500))
      storeEmbedding(db, 'observation', obsId, embedding)
    } catch {
      console.warn(`  [warn] embedding failed for section, stored without embedding`)
    }
    obsCount++
  }

  try {
    const entityEmbedding = await embedText(`${name}: ${type}`)
    storeEmbedding(db, 'entity', entityId, entityEmbedding)
  } catch {
    console.warn(`  [warn] entity embedding failed`)
  }

  console.log(`Done: ${obsCount} observations stored for "${name}"`)
}

main().catch((err) => { console.error(err); process.exit(1) })
