#!/usr/bin/env tsx
// Backfill: rewrite linkedin platform_url for every 'published' row from the
// broken `urn:li:activity:X` template to the correct `urn:li:share:X` template
// that actually resolves. The platform_post_id (the share URN) is our source
// of truth; platform_url was derived incorrectly and is rebuilt from it.

import { initDatabase } from '../src/db.js'

const db = initDatabase()

const rows = db
  .prepare(
    `SELECT id, platform_post_id, platform_url
     FROM social_posts
     WHERE platform = 'linkedin'
       AND status = 'published'
       AND platform_post_id LIKE 'urn:li:share:%'`,
  )
  .all() as Array<{ id: string; platform_post_id: string; platform_url: string | null }>

console.log(`Found ${rows.length} LinkedIn rows to inspect.`)

let fixed = 0
const stmt = db.prepare(`UPDATE social_posts SET platform_url = ? WHERE id = ?`)

for (const row of rows) {
  const correctUrl = `https://www.linkedin.com/feed/update/${row.platform_post_id}/`
  if (row.platform_url === correctUrl) {
    console.log(`  [skip] ${row.id} already correct`)
    continue
  }
  stmt.run(correctUrl, row.id)
  console.log(`  [fix]  ${row.id}  ${row.platform_url} -> ${correctUrl}`)
  fixed += 1
}

console.log(`\nDone. ${fixed} rows updated.`)
