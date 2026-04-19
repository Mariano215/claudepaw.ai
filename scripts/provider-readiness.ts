#!/usr/bin/env tsx
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')
const DB_PATH = join(PROJECT_ROOT, 'store', 'claudepaw.db')

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const ok = (label: string, detail?: string) =>
  console.log(`  ${GREEN}\u2713${RESET} ${label}${detail ? ` ${DIM}(${detail})${RESET}` : ''}`)
const fail = (label: string, detail?: string) =>
  console.log(`  ${RED}\u2717${RESET} ${label}${detail ? ` ${DIM}(${detail})${RESET}` : ''}`)
const warn = (label: string, detail?: string) =>
  console.log(`  ${YELLOW}\u26a0${RESET} ${label}${detail ? ` ${DIM}(${detail})${RESET}` : ''}`)

function readEnv(): Record<string, string> {
  const envPath = join(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) return {}
  const content = readFileSync(envPath, 'utf-8')
  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    result[key] = val
  }
  return result
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

function binaryPresent(cmd: string): string | null {
  try {
    return execSync(`which ${cmd}`, { encoding: 'utf-8' }).trim() || null
  } catch {
    return null
  }
}

console.log(`\n${BOLD}ClaudePaw Provider Readiness${RESET}\n`)

const env = readEnv()

const claudePath = binaryPresent('claude')
if (claudePath) ok('Claude Desktop CLI', claudePath)
else warn('Claude Desktop CLI', 'not found in PATH')

const codexPath = binaryPresent('codex')
if (codexPath) ok('Codex Local CLI', codexPath)
else warn('Codex Local CLI', 'not found in PATH')

if (env.ANTHROPIC_API_KEY) ok('Anthropic API env key', 'present')
else warn('Anthropic API env key', 'missing')

if (env.OPENAI_API_KEY) ok('OpenAI API env key', 'present')
else warn('OpenAI API env key', 'missing')

if (!existsSync(DB_PATH)) {
  fail('Bot database', 'store/claudepaw.db not found')
  console.log('')
  process.exit(1)
}

const db = new Database(DB_PATH, { readonly: true })

const hasExecutionColumns =
  hasColumn(db, 'project_settings', 'execution_provider')
  && hasColumn(db, 'project_settings', 'execution_model')
  && hasColumn(db, 'project_settings', 'fallback_policy')
  && hasColumn(db, 'project_settings', 'model_tier')

if (hasExecutionColumns) ok('Project settings migration', 'execution columns present')
else warn('Project settings migration', 'execution columns missing; start the app once to run DB migrations')

const projects = db.prepare('SELECT id, display_name FROM projects ORDER BY id').all() as Array<{ id: string; display_name: string }>
if (projects.length === 0) {
  warn('Projects', 'none found')
} else {
  ok('Projects', `${projects.length} found`)
}

for (const project of projects) {
  console.log(`\n${BOLD}${project.display_name}${RESET} ${DIM}[${project.id}]${RESET}`)

  const rows = db.prepare(`
    SELECT service, key
    FROM project_credentials
    WHERE project_id = ?
      AND service IN ('anthropic', 'anthropic_api', 'openai', 'openai_api')
    ORDER BY service, key
  `).all(project.id) as Array<{ service: string; key: string }>

  const grouped = new Map<string, string[]>()
  for (const row of rows) {
    if (!grouped.has(row.service)) grouped.set(row.service, [])
    grouped.get(row.service)!.push(row.key)
  }

  if (hasExecutionColumns) {
    const settings = db.prepare(`
      SELECT execution_provider, execution_model, fallback_policy, model_tier
      FROM project_settings
      WHERE project_id = ?
    `).get(project.id) as
      | { execution_provider: string | null; execution_model: string | null; fallback_policy: string | null; model_tier: string | null }
      | undefined

    if (settings?.execution_provider || settings?.execution_model || settings?.fallback_policy || settings?.model_tier) {
      ok(
        'Execution defaults',
        `${settings?.execution_provider ?? 'default'} | ${settings?.execution_model ?? 'auto'} | ${settings?.fallback_policy ?? 'disabled'} | ${settings?.model_tier ?? 'balanced'}`,
      )
    } else {
      warn('Execution defaults', 'not configured')
    }
  }

  const anthropicKeys = grouped.get('anthropic') ?? grouped.get('anthropic_api') ?? []
  const openaiKeys = grouped.get('openai') ?? grouped.get('openai_api') ?? []

  if (anthropicKeys.includes('api_key')) ok('Anthropic project credential', 'api_key present')
  else warn('Anthropic project credential', 'api_key missing')

  if (openaiKeys.includes('api_key')) ok('OpenAI project credential', 'api_key present')
  else warn('OpenAI project credential', 'api_key missing')
}

console.log(`\n${DIM}Recommended validation flow:${RESET}`)
console.log('  1. Start the app once so DB migrations run.')
console.log('  2. Add provider keys via Credentials or .env.')
console.log('  3. Run: node --import tsx scripts/provider-readiness.ts')
console.log('  4. Then exercise a project with the selected provider in the UI.\n')

db.close()
