#!/usr/bin/env tsx
/**
 * One-time migration: convert learned_skills and learned_patches into knowledge graph.
 * Safe to run multiple times (upsert-based).
 * Usage: npm run knowledge:migrate
 */
import { initDatabase, getDb, initVecTable } from '../src/db.js'
import { upsertEntity, addObservation } from '../src/knowledge.js'
import { embedText, storeEmbedding } from '../src/embeddings.js'
import { EMBEDDING_DIMENSIONS } from '../src/config.js'

async function main() {
  initDatabase()
  const db = getDb()
  initVecTable(db, EMBEDDING_DIMENSIONS)

  // Check if tables exist before querying
  const hasSkills = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learned_skills'")
    .get()
  const hasPatches = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='learned_patches'")
    .get()

  if (!hasSkills) {
    console.log('learned_skills table not found — skipping')
  } else {
    const skills = db
      .prepare("SELECT * FROM learned_skills WHERE status = 'active'")
      .all() as Array<{
        id: number
        title: string
        content: string
        effectiveness: number
        project_id: string | null
      }>

    console.log(`Migrating ${skills.length} learned_skills...`)
    for (const skill of skills) {
      const entityId = upsertEntity({
        name: skill.title,
        type: 'skill',
        summary: `Effectiveness: ${skill.effectiveness}`,
        projectId: skill.project_id,
      })
      const obsId = addObservation({
        entityId,
        content: skill.content.slice(0, 1000),
        source: 'authored',
        confidence: skill.effectiveness,
      })
      try {
        const embedding = await embedText(skill.content.slice(0, 500))
        storeEmbedding(db, 'observation', obsId, embedding)
      } catch {
        // embedding unavailable — stored without vector
      }
      console.log(`  + Skill: ${skill.title}`)
    }
  }

  if (!hasPatches) {
    console.log('learned_patches table not found — skipping')
  } else {
    const patches = db
      .prepare('SELECT * FROM learned_patches WHERE expires_at > ?')
      .all(Date.now()) as Array<{ id: string; content: string; expires_at: number }>

    console.log(`\nMigrating ${patches.length} active learned_patches...`)
    for (const patch of patches) {
      const name = `patch-${patch.id.slice(0, 8)}`
      const entityId = upsertEntity({ name, type: 'skill', summary: 'Migrated patch', projectId: null })
      const obsId = addObservation({
        entityId,
        content: patch.content.slice(0, 500),
        source: 'feedback',
        confidence: 0.9,
      })
      // Preserve original expiry as valid_until
      db.prepare('UPDATE observations SET valid_until = ? WHERE id = ?').run(patch.expires_at, obsId)
      try {
        const embedding = await embedText(patch.content.slice(0, 500))
        storeEmbedding(db, 'observation', obsId, embedding)
      } catch {
        // embedding unavailable — stored without vector
      }
      console.log(`  + Patch: ${name}`)
    }
  }

  console.log('\nMigration complete.')
}

main().catch((err) => { console.error(err); process.exit(1) })
