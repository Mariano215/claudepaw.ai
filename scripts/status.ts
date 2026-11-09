#!/usr/bin/env tsx
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------
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

console.log(`\n${BOLD}ClaudePaw Status${RESET}\n`)

// ---------------------------------------------------------------------------
// Read .env
// ---------------------------------------------------------------------------
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

const env = readEnv()

// Node version
const major = parseInt(process.versions.node.split('.')[0], 10)
if (major >= 20) ok(`Node.js ${process.versions.node}`)
else fail(`Node.js ${process.versions.node}`, 'need >= 20')

// Claude CLI
try {
  const v = execSync('claude --version 2>&1', { encoding: 'utf-8' }).trim()
  ok(`Claude CLI`, v)
} catch {
  fail('Claude CLI', 'not installed')
}

// Telegram bot token
const token = env.TELEGRAM_BOT_TOKEN
if (token) {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const data = await resp.json() as { ok: boolean; result?: { username: string } }
    if (data.ok) {
      ok(`Telegram bot`, `@${data.result?.username}`)
    } else {
      fail('Telegram bot', 'invalid token')
    }
  } catch {
    fail('Telegram bot', 'could not reach Telegram API')
  }
} else {
  fail('Telegram bot', 'TELEGRAM_BOT_TOKEN not set')
}

// Chat ID
if (env.ALLOWED_CHAT_ID) ok(`Chat ID`, env.ALLOWED_CHAT_ID)
else warn('Chat ID', 'not set - bot will accept all chats')

if (env.DASHBOARD_API_TOKEN) ok('Dashboard API token', 'present')
else fail('Dashboard API token', 'DASHBOARD_API_TOKEN not set')

if (env.WS_SECRET) ok('Dashboard WS secret', 'present')
else fail('Dashboard WS secret', 'WS_SECRET not set')

// STT
const sttUrl = env.STT_URL ?? 'http://localhost:8010/v1/audio/transcriptions'
try {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  // Just check if the server is reachable with a GET (may return 405 but that's OK)
  await fetch(sttUrl.replace('/v1/audio/transcriptions', '/'), { signal: controller.signal })
  clearTimeout(timeout)
  ok('STT server', sttUrl)
} catch {
  warn('STT server', `unreachable at ${sttUrl}`)
}

// TTS
const ttsUrl = env.TTS_URL ?? 'http://localhost:8095/v1/tts'
try {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  await fetch(ttsUrl.replace('/v1/tts', '/health'), { signal: controller.signal })
  clearTimeout(timeout)
  ok('TTS server', ttsUrl)
} catch {
  warn('TTS server', `unreachable at ${ttsUrl}`)
}

// Database
const dbPath = join(PROJECT_ROOT, 'store', 'claudepaw.db')
if (existsSync(dbPath)) {
  try {
    // Dynamic import to avoid top-level SQLite issues if not installed
    const Database = (await import('better-sqlite3')).default
    const db = new Database(dbPath, { readonly: true })
    const memCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c
    const taskCount = (db.prepare('SELECT COUNT(*) as c FROM scheduled_tasks').get() as { c: number }).c
    const sessionCount = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c
    db.close()
    ok(`Database`, `${memCount} memories, ${taskCount} tasks, ${sessionCount} sessions`)
  } catch (err) {
    warn('Database', `exists but could not read: ${err}`)
  }
} else {
  warn('Database', 'not yet created (will be created on first run)')
}

// PID file
const pidPath = join(PROJECT_ROOT, 'store', 'claudepaw.pid')
if (existsSync(pidPath)) {
  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10)
  try {
    process.kill(pid, 0)
    ok(`Process running`, `PID ${pid}`)
  } catch {
    warn('Process', `PID file exists (${pid}) but process not running`)
  }
} else {
  warn('Process', 'not running')
}

console.log('')
