/**
 * Smoke test for the GitHub section pipeline:
 *   1. Initialize newsletter tables
 *   2. Collect candidates via GH Search API (rising + established buckets)
 *   3. Shortlist with dedup + 60/40 mix
 *   4. Curate with Claude Sonnet (LLM) — or fall back to deterministic top 6
 *   5. Print picks
 *
 * Usage: npx tsx scripts/test-github-section.ts
 */
import { createNewsletterTables } from '../src/newsletter/dedup.js'
import { collectRepoCandidates, shortlistRepos } from '../src/newsletter/github-collector.js'
import { curateRepos } from '../src/newsletter/github-curator.js'

async function main() {
  createNewsletterTables()
  const startedAt = Date.now()

  console.log('Collecting candidates from GitHub Search API…')
  const candidates = await collectRepoCandidates()
  console.log(`Candidates: ${candidates.length}`)
  if (candidates.length === 0) {
    console.log('No candidates — check GITHUB_TOKEN env or `gh auth status`.')
    return
  }

  const shortlist = shortlistRepos(candidates)
  console.log(`Shortlist: ${shortlist.length}`)
  console.log('  Top 5 by score:')
  for (const r of shortlist.slice(0, 5)) {
    console.log(`    ${r.tag.padEnd(8)} ${r.fullName.padEnd(40)} ${r.stars}★  score=${r.score}`)
  }

  console.log('\nCurating via LLM (or deterministic fallback)…')
  const picks = await curateRepos(shortlist)
  console.log(`\nFinal picks (${picks.length}):`)
  for (const p of picks) {
    console.log(`\n  [${p.tag}] ${p.fullName}  (${p.stars}★ · ${p.language ?? 'multi'})`)
    console.log(`    ${p.whyItMatters}`)
    console.log(`    ${p.url}`)
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`\nDone in ${elapsed}s.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
