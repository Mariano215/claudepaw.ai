#!/usr/bin/env tsx
/**
 * Paws seed: creates example paw configs in the database.
 * Safe to re-run -- uses INSERT OR IGNORE so existing paws are not overwritten.
 *
 * Usage:
 *   npm run paws:seed
 *
 * Included paws:
 *   security-patrol  -- scans your ClaudePaw installation every 4 hours (active)
 *   repo-health      -- monitors a GitHub repo for issues/PRs (paused, needs config)
 *
 * To activate repo-health:
 *   1. Set GITHUB_REPO below to your repo slug (e.g. "username/my-repo")
 *   2. Re-run: npm run paws:seed
 *   3. Resume: npm run paws resume repo-health
 */
import { initDatabase, checkpointAndCloseDatabase, getDb } from '../src/db.js'
import { computeNextRun } from '../src/scheduler.js'
import { ALLOWED_CHAT_ID } from '../src/config.js'

const chatId = ALLOWED_CHAT_ID || process.env.TELEGRAM_CHAT_ID || ''

if (!chatId) {
  console.warn(
    '[paws-seed] WARNING: ALLOWED_CHAT_ID is not set in .env\n' +
    '  Paws will be created but reports will have no Telegram destination.\n' +
    '  Set ALLOWED_CHAT_ID in .env and re-run to fix.',
  )
}

// TODO: Set this to your GitHub repo slug to enable repo-health paw.
// Example: const GITHUB_REPO = 'username/my-project'
const GITHUB_REPO = ''

interface PawSeed {
  id: string
  project_id: string
  name: string
  agent_id: string
  cron: string
  status: 'active' | 'paused'
  approval_threshold: number
  approval_timeout_sec: number
  phase_instructions?: Record<string, string>
}

const PAWS: PawSeed[] = [
  // ── Security (works out of the box) ───────────────────────────────────────
  {
    id: 'security-patrol',
    project_id: 'default',
    name: 'Security Patrol',
    agent_id: 'auditor',
    cron: '0 */4 * * *',
    status: 'active',
    approval_threshold: 4,
    approval_timeout_sec: 300,
    phase_instructions: {
      observe:
        'Run security checks on this ClaudePaw installation using the Bash tool:\n' +
        '1. Check for world-writable files: find . -maxdepth 3 -not -path "*/node_modules/*" -not -path "*/.git/*" -perm -o+w -type f 2>/dev/null | head -20\n' +
        '2. Check for .env files accidentally committed: git log --oneline --all -- "*.env" 2>/dev/null | head -10\n' +
        '3. Check listening ports: lsof -i -P -n 2>/dev/null | grep LISTEN | grep -v "127.0.0.1" | head -20\n' +
        'Output all raw results.',
      analyze:
        'Compare findings against previous cycle.\n' +
        'Severity: exposed credential = 5, world-writable sensitive file = 4, unexpected open port = 3, minor config issue = 2.\n' +
        'Mark is_new=true only for issues not seen in the previous cycle.',
      act: 'No automated actions. This paw is observe-only.',
      report:
        'Report only new or changed findings since last cycle.\n' +
        'If nothing new, say "No new security findings." Keep it tight.',
    },
  },

  // ── GitHub Repo Health (paused -- set GITHUB_REPO above to activate) ──────
  {
    id: 'repo-health',
    project_id: 'default',
    name: 'Repo Health',
    agent_id: 'community',
    cron: '0 10 * * 1,3,5',
    status: 'paused',
    approval_threshold: 2,
    approval_timeout_sec: 300,
    phase_instructions: {
      observe: GITHUB_REPO
        ? 'Check ' + GITHUB_REPO + ' for activity using the Bash tool (gh CLI only):\n' +
          '1. gh issue list -R ' + GITHUB_REPO + ' --state open --sort created --json number,title,labels,createdAt,updatedAt\n' +
          '2. gh pr list -R ' + GITHUB_REPO + ' --state open --json number,title,author,createdAt\n' +
          "3. gh api repos/" + GITHUB_REPO + " --jq '{stars:.stargazers_count,forks:.forks_count,open_issues:.open_issues_count}'\n" +
          'Output all raw results.'
        : 'GITHUB_REPO is not configured. Edit scripts/paws-seed.ts, set GITHUB_REPO to your repo slug, re-run npm run paws:seed, then resume this paw.',
      analyze:
        'Compare issues/PRs against previous cycle. Mark is_new=true for new items.\n' +
        'Severity: new PR needing review = 4, new issue = 3, stale issue >7 days = 2, metric change = 1.',
      act: 'No automated actions.',
      report:
        'Report only new or changed items since last cycle.\n' +
        'If nothing new, say "No new activity." Keep it tight.',
    },
  },
]

function main(): void {
  initDatabase()
  const db = getDb()

  const insert = db.prepare(`
    INSERT OR IGNORE INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let created = 0
  let skipped = 0

  for (const paw of PAWS) {
    const config = JSON.stringify({
      approval_threshold: paw.approval_threshold,
      approval_timeout_sec: paw.approval_timeout_sec,
      chat_id: chatId,
      ...(paw.phase_instructions ? { phase_instructions: paw.phase_instructions } : {}),
    })

    const nextRun = computeNextRun(paw.cron)
    const result = insert.run(
      paw.id, paw.project_id, paw.name, paw.agent_id,
      paw.cron, paw.status, config, nextRun, Date.now(),
    ) as { changes: number }

    if (result.changes > 0) {
      console.log(`  + ${paw.id} (${paw.name}) [${paw.status}]`)
      created++
    } else {
      console.log(`  ~ ${paw.id} (already exists, skipped)`)
      skipped++
    }
  }

  console.log(`\nDone: ${created} created, ${skipped} already existed`)
  if (created > 0 && !GITHUB_REPO) {
    console.log('\nTip: Set GITHUB_REPO in scripts/paws-seed.ts and re-run to enable repo-health.')
  }

  checkpointAndCloseDatabase()
}

main()
