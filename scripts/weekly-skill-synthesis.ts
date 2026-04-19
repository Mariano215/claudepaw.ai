#!/usr/bin/env node
/**
 * Weekly Skill Synthesis
 *
 * Analyzes recent commits, errors, and patterns to create learned skills.
 * Run weekly to capture engineering patterns and prevent recurring bugs.
 */

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const DB_PATH = resolve(process.cwd(), 'store/claudepaw.db')
const SKILLS_JSON = process.argv[2] || '/tmp/new_skills.json'

interface NewSkill {
  title: string
  content: string
  agent_id: string
  effectiveness: number
}

function insertSkills(skillsPath: string) {
  const db = new Database(DB_PATH)
  const skills: NewSkill[] = JSON.parse(readFileSync(skillsPath, 'utf-8'))

  const insert = db.prepare(`
    INSERT INTO learned_skills (uuid, agent_id, title, content, source_ids, effectiveness, created_at, status, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const now = Date.now()
  let inserted = 0

  console.log(`\n📚 Weekly Skill Synthesis\n`)
  console.log(`Reading skills from: ${skillsPath}`)
  console.log(`Found ${skills.length} skills to insert\n`)

  for (const skill of skills) {
    const uuid = randomUUID()

    try {
      insert.run(
        uuid,
        skill.agent_id,
        skill.title,
        skill.content,
        JSON.stringify([]), // source_ids
        skill.effectiveness,
        now,
        'active',
        'default'
      )
      inserted++
      console.log(`✅ ${skill.title}`)
      console.log(`   Agent: ${skill.agent_id}, Effectiveness: ${skill.effectiveness}`)
    } catch (err: any) {
      console.error(`❌ Failed to insert "${skill.title}": ${err.message}`)
    }
  }

  console.log(`\n✨ Inserted ${inserted}/${skills.length} learned skills`)

  // Show summary stats
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
      AVG(effectiveness) as avg_effectiveness
    FROM learned_skills
    WHERE project_id = 'default'
  `).get() as { total: number; active: number; avg_effectiveness: number }

  console.log(`\n📊 Total Skills: ${stats.total} (${stats.active} active)`)
  console.log(`📈 Average Effectiveness: ${(stats.avg_effectiveness * 100).toFixed(1)}%\n`)

  db.close()
}

// Check for duplicate deploy confirmation skills and clean up
function deduplicateDeploySkills() {
  const db = new Database(DB_PATH)

  const duplicates = db.prepare(`
    SELECT id, uuid, agent_id, created_at
    FROM learned_skills
    WHERE title = 'Deploy confirmation'
    ORDER BY created_at ASC
  `).all() as Array<{ id: number; uuid: string; agent_id: string; created_at: number }>

  if (duplicates.length > 1) {
    console.log(`\n🔧 Found ${duplicates.length} duplicate "Deploy confirmation" skills`)
    console.log(`   Keeping oldest (id: ${duplicates[0].id}), removing ${duplicates.length - 1} duplicates\n`)

    const deleteIds = duplicates.slice(1).map(d => d.id)
    const deleteStmt = db.prepare('DELETE FROM learned_skills WHERE id = ?')

    for (const id of deleteIds) {
      deleteStmt.run(id)
    }

    console.log(`✅ Removed ${deleteIds.length} duplicate skills\n`)
  }

  db.close()
}

// Main
try {
  deduplicateDeploySkills()
  insertSkills(SKILLS_JSON)
} catch (err: any) {
  console.error(`\n❌ Error: ${err.message}`)
  process.exit(1)
}
