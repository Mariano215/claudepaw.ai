#!/usr/bin/env tsx
/**
 * ClaudePaw Onboarding Wizard
 *
 * Interactive CLI that walks through every configuration step needed
 * to get a ClaudePaw instance running. Replaces the old bare-bones setup.
 *
 * Run: npm run setup   (or:  npx tsx scripts/setup.ts)
 */

import { input, password, checkbox, select, confirm } from '@inquirer/prompts'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  toSlug,
  parseAgentFrontmatter,
  readEnvFile as parseEnvContent,
  THEME_PRESETS,
  type AgentMeta,
  type ThemePreset,
} from './setup-helpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const ok = (msg: string) => console.log(`${GREEN}\u2713${RESET} ${msg}`)
const warn = (msg: string) => console.log(`${YELLOW}\u26a0${RESET} ${msg}`)
const fail = (msg: string) => console.log(`${RED}\u2717${RESET} ${msg}`)
const header = (msg: string) => console.log(`\n${BOLD}${CYAN}--- ${msg} ---${RESET}\n`)
const dim = (msg: string) => `${DIM}${msg}${RESET}`

function loadAgents(dir: string): AgentMeta[] {
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
  const agents: AgentMeta[] = []
  for (const file of files) {
    const meta = parseAgentFrontmatter(join(dir, file))
    if (meta) agents.push(meta)
  }
  return agents
}

// ---------------------------------------------------------------------------
// Existing .env reader (wraps the pure-function helper with file I/O)
// ---------------------------------------------------------------------------
function readEnvFile(): Record<string, string> {
  const envPath = join(PROJECT_ROOT, '.env')
  let content: string
  try {
    content = readFileSync(envPath, 'utf-8')
  } catch {
    return {}
  }
  return parseEnvContent(content)
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------
async function main() {
  // =========================================================================
  // Step 1: Welcome banner
  // =========================================================================
  console.log(`
${BOLD}
 \u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2557      \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557
\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d\u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255d
\u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2557
\u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u255d
\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551  \u2588\u2588\u2551\u255a\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255d\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557
 \u255a\u2550\u2550\u2550\u2550\u2550\u255d\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d\u255a\u2550\u255d  \u255a\u2550\u255d \u255a\u2550\u2550\u2550\u2550\u2550\u255d \u255a\u2550\u2550\u2550\u2550\u2550\u255d\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u255d
 \u2588\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557    \u2588\u2588\u2557
\u2588\u2588\u2554\u2550\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551    \u2588\u2588\u2551
\u2588\u2588\u2551\u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551 \u2588\u2557 \u2588\u2588\u2551
\u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2551\u2588\u2588\u2588\u2557\u2588\u2588\u2551
\u255a\u2588\u2588\u2588\u2588\u2588\u2554\u255d\u2588\u2588\u2551  \u2588\u2588\u2551\u255a\u2588\u2588\u2588\u2554\u2588\u2588\u2588\u2554\u255d
 \u255a\u2550\u2550\u2550\u2550\u255d \u255a\u2550\u255d  \u255a\u2550\u255d \u255a\u2550\u2550\u255d\u255a\u2550\u2550\u255d   setup wizard
${RESET}`)

  console.log('ClaudePaw is a persistent AI assistant accessible via Telegram (and other channels).')
  console.log('This wizard will configure your instance.\n')

  // =========================================================================
  // Step 2: Requirements check
  // =========================================================================
  header('Requirements Check')

  // Node version
  const nodeVersion = process.versions.node
  const major = parseInt(nodeVersion.split('.')[0], 10)
  if (major >= 20) {
    ok(`Node.js ${nodeVersion}`)
  } else {
    fail(`Node.js ${nodeVersion} -- need >= 20`)
    process.exit(1)
  }

  // Claude CLI
  try {
    const claudeVersion = execFileSync('claude', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    ok(`Claude CLI: ${claudeVersion}`)
  } catch {
    warn('Claude CLI not found. Agents won\'t run until you install it: https://docs.anthropic.com/en/docs/claude-code')
    console.log(dim('  Setup will continue -- you can install Claude CLI later.\n'))
  }

  // =========================================================================
  // Step 3: Telegram config
  // =========================================================================
  header('Telegram Configuration')
  console.log(dim('Get your bot token from @BotFather on Telegram'))

  const botToken = await password({
    message: 'Telegram bot token:',
    mask: '*',
    validate: (val) => {
      if (!val.trim()) return 'Bot token is required'
      if (!/^\d+:[A-Za-z0-9_-]+$/.test(val.trim())) return 'Invalid format. Expected: 123456:ABC-DEF...'
      return true
    },
  })

  const chatId = await input({
    message: 'Allowed chat ID:',
    default: '123456789',
    validate: (val) => {
      if (!/^\d+$/.test(val.trim())) return 'Must be numeric'
      return true
    },
  })

  // =========================================================================
  // Step 4: Claude config
  // =========================================================================
  header('Claude Configuration')

  const claudeCwd = await input({
    message: 'Claude working directory (CLAUDE_CWD):',
    default: process.cwd(),
    validate: (val) => {
      if (!existsSync(val.trim())) return `Path does not exist: ${val.trim()}`
      return true
    },
  })

  // =========================================================================
  // Step 5: Channel selection
  // =========================================================================
  header('Channels')
  console.log(dim('Select messaging channels to enable'))

  const channelChoices = await checkbox({
    message: 'Enabled channels:',
    choices: [
      { name: 'Telegram', value: 'telegram', checked: true, disabled: '(required)' },
      { name: 'Discord', value: 'discord' },
      { name: 'iMessage', value: 'imessage' },
      { name: 'WhatsApp', value: 'whatsapp' },
      { name: 'Slack', value: 'slack' },
    ],
  })

  // Always include telegram
  const enabledChannels = ['telegram', ...channelChoices]

  // Collect per-channel config
  const channelConfig: Record<string, string> = {}

  if (enabledChannels.includes('discord')) {
    header('Discord Configuration')
    channelConfig.DISCORD_BOT_TOKEN = await password({
      message: 'Discord bot token:',
      mask: '*',
      validate: (val) => (val.trim() ? true : 'Required'),
    })
    channelConfig.DISCORD_ALLOWED_USER_IDS = await input({
      message: 'Allowed Discord user IDs (comma-separated):',
      validate: (val) => (val.trim() ? true : 'At least one user ID required'),
    })
  }

  if (enabledChannels.includes('whatsapp')) {
    header('WhatsApp Configuration')
    channelConfig.WHATSAPP_ALLOWED_NUMBERS = await input({
      message: 'Allowed phone numbers (comma-separated, with country code):',
      validate: (val) => (val.trim() ? true : 'At least one number required'),
    })
  }

  if (enabledChannels.includes('slack')) {
    header('Slack Configuration')
    channelConfig.SLACK_BOT_TOKEN = await password({
      message: 'Slack bot token (xoxb-...):',
      mask: '*',
      validate: (val) => (val.trim() ? true : 'Required'),
    })
    channelConfig.SLACK_APP_TOKEN = await password({
      message: 'Slack app token (xapp-...):',
      mask: '*',
      validate: (val) => (val.trim() ? true : 'Required'),
    })
  }

  // =========================================================================
  // Step 6: First project
  // =========================================================================
  header('First Project')
  console.log(dim('Set up your first project for the dashboard'))

  const projectName = await input({
    message: 'Project name:',
    validate: (val) => (val.trim() ? true : 'Project name is required'),
  })

  const defaultSlug = toSlug(projectName)
  const projectSlug = await input({
    message: 'Project slug:',
    default: defaultSlug,
    validate: (val) => {
      if (!/^[a-z0-9-]+$/.test(val.trim())) return 'Only lowercase letters, numbers, and hyphens'
      return true
    },
  })

  // Theme selection
  const themeChoice = await select({
    message: 'Color theme:',
    choices: [
      ...THEME_PRESETS.map((t) => ({
        name: `${t.name}  ${dim(`${t.primary} / ${t.accent}`)}`,
        value: t.name,
      })),
      { name: 'Custom', value: 'custom' },
    ],
  })

  let primaryColor: string
  let accentColor: string

  if (themeChoice === 'custom') {
    primaryColor = await input({
      message: 'Primary color (hex):',
      default: '#1e1b4b',
      validate: (val) => (/^#[0-9a-fA-F]{6}$/.test(val.trim()) ? true : 'Must be #RRGGBB format'),
    })
    accentColor = await input({
      message: 'Accent color (hex):',
      default: '#7c3aed',
      validate: (val) => (/^#[0-9a-fA-F]{6}$/.test(val.trim()) ? true : 'Must be #RRGGBB format'),
    })
  } else {
    const preset = THEME_PRESETS.find((t) => t.name === themeChoice)!
    primaryColor = preset.primary
    accentColor = preset.accent
  }

  // =========================================================================
  // Step 7: Agent selection (template-based)
  // =========================================================================
  header('Agents')

  // Show base agents (always included)
  const baseAgents = loadAgents(join(PROJECT_ROOT, 'agents'))
  if (baseAgents.length > 0) {
    console.log(dim('Base agents (always active, project-agnostic):'))
    for (const a of baseAgents) {
      ok(`${a.emoji} ${a.name} -- ${a.role}`)
    }
    console.log()
  }

  // Show available templates for the user to pick
  const templatesDir = join(PROJECT_ROOT, 'templates')
  const templates = loadAgents(templatesDir)
  let enabledAgentIds: string[] = baseAgents.map((a) => a.id)

  if (templates.length > 0) {
    console.log(dim('Choose agent roles for your project.'))
    console.log(dim('Templates are copied to your project and customized for your use case.\n'))

    const templateChoices = await checkbox({
      message: `Agents for "${projectName}":`,
      choices: templates.map((t) => ({
        name: `${t.emoji} ${t.name} -- ${t.role}`,
        value: t.id,
      })),
    })

    if (templateChoices.length > 0) {
      // Copy selected templates to project agents dir
      const projectAgentsDir = join(PROJECT_ROOT, 'projects', projectSlug.trim(), 'agents')
      mkdirSync(projectAgentsDir, { recursive: true })

      for (const templateId of templateChoices) {
        const srcPath = join(templatesDir, `${templateId}.md`)
        const destPath = join(projectAgentsDir, `${templateId}.md`)
        if (existsSync(srcPath) && !existsSync(destPath)) {
          const content = readFileSync(srcPath, 'utf-8')
          writeFileSync(destPath, content)
          ok(`Copied template: ${templateId}`)
        }
      }

      console.log(dim(`\nCustomize your agents in: projects/${projectSlug.trim()}/agents/`))
      enabledAgentIds = [...enabledAgentIds, ...templateChoices]
    }
  } else {
    warn('No agent templates found in templates/ directory')
  }

  // Check for existing project agents (if dir was pre-populated)
  const existingProjectAgents = loadAgents(join(PROJECT_ROOT, 'projects', projectSlug.trim(), 'agents'))
  if (existingProjectAgents.length > 0) {
    const existingIds = existingProjectAgents.map((a) => a.id)
    const newIds = existingIds.filter((id) => !enabledAgentIds.includes(id))
    enabledAgentIds = [...enabledAgentIds, ...newIds]
    if (newIds.length > 0) {
      console.log(dim(`Found ${existingProjectAgents.length} existing project agent(s)`))
    }
  }

  // =========================================================================
  // Step 8: Security config (optional)
  // =========================================================================
  const securityConfig: Record<string, string> = {}

  const configureSecurity = await confirm({
    message: 'Configure security scanning?',
    default: false,
  })

  if (configureSecurity) {
    header('Security Scanner')

    securityConfig.SECURITY_PROJECT_PATHS = await input({
      message: 'Project paths to scan (comma-separated absolute paths):',
      default: PROJECT_ROOT,
    })

    securityConfig.SECURITY_GITHUB_OWNER = await input({
      message: 'GitHub username:',
    })

    securityConfig.SECURITY_DOMAINS = await input({
      message: 'Domains to monitor (comma-separated):',
    })

    securityConfig.SECURITY_TAILSCALE_NODES = await input({
      message: 'Tailscale node hostnames (comma-separated):',
    })

    securityConfig.SECURITY_AUTO_FIX_MAX_SEVERITY = await select({
      message: 'Auto-fix max severity:',
      choices: [
        { name: 'low', value: 'low' },
        { name: 'medium', value: 'medium' },
        { name: 'high', value: 'high' },
        { name: 'critical', value: 'critical' },
      ],
      default: 'medium',
    })
  }

  // =========================================================================
  // Step 8b: Dashboard URL
  // =========================================================================
  header('Dashboard Setup')
  console.log(dim('The dashboard server exposes the API the bot uses for OAuth tokens, metrics, and live status.'))

  const installType = await select({
    message: 'Where will the ClaudePaw dashboard server run?',
    choices: [
      { name: 'Same machine as the bot (local install)', value: 'local' },
      { name: 'Remote / separate server', value: 'remote' },
    ],
    default: 'local',
  })

  let dashboardUrl = 'http://localhost:3000'
  if (installType === 'remote') {
    dashboardUrl = await input({
      message: 'Dashboard server URL (e.g. http://192.168.1.100:3000 or https://dashboard.example.com):',
      default: 'http://localhost:3000',
      validate: (v) => v.startsWith('http') ? true : 'Must start with http:// or https://',
    })
  }

  // =========================================================================
  // Step 9: Write .env
  // =========================================================================
  header('Write .env')

  const envPath = join(PROJECT_ROOT, '.env')
  const existingEnv = readEnvFile()
  let doMerge = false

  if (existsSync(envPath)) {
    const overwrite = await confirm({
      message: 'Existing .env found. Overwrite it completely?',
      default: false,
    })
    doMerge = !overwrite
    if (doMerge) {
      console.log(dim('Merging: wizard values override existing, other keys preserved'))
    }
  }

  // Build the env values map from wizard answers
  const wizardValues: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: botToken.trim(),
    ALLOWED_CHAT_ID: chatId.trim(),
    CLAUDE_CWD: claudeCwd.trim(),
    CHANNELS_ENABLED: enabledChannels.join(','),
    ENABLED_AGENTS: enabledAgentIds.join(','),
    DASHBOARD_URL: dashboardUrl,
    ...channelConfig,
    ...securityConfig,
  }

  // Dashboard/API secrets: keep existing or generate new
  if (doMerge && existingEnv.DASHBOARD_API_TOKEN) {
    wizardValues.DASHBOARD_API_TOKEN = existingEnv.DASHBOARD_API_TOKEN
  } else if (!wizardValues.DASHBOARD_API_TOKEN) {
    wizardValues.DASHBOARD_API_TOKEN = randomBytes(32).toString('hex')
  }

  // WS_SECRET: keep existing or generate new
  if (doMerge && existingEnv.WS_SECRET) {
    wizardValues.WS_SECRET = existingEnv.WS_SECRET
  } else if (!wizardValues.WS_SECRET) {
    wizardValues.WS_SECRET = randomBytes(32).toString('hex')
  }

  // Merge: existing values as base, wizard values override
  const finalValues: Record<string, string> = doMerge ? { ...existingEnv, ...wizardValues } : wizardValues

  // Build the .env content with section comments
  const lines: string[] = [
    '# ClaudePaw configuration',
    '# Generated by setup wizard',
    '',
    '# === Telegram ===',
    `TELEGRAM_BOT_TOKEN=${finalValues.TELEGRAM_BOT_TOKEN || ''}`,
    `ALLOWED_CHAT_ID=${finalValues.ALLOWED_CHAT_ID || '123456789'}`,
    '',
    '# === Claude Code ===',
    `CLAUDE_CWD=${finalValues.CLAUDE_CWD || ''}`,
    '',
    '# === Voice -- Local STT (WhisperX) ===',
    `STT_URL=${finalValues.STT_URL || 'http://localhost:8010/v1/audio/transcriptions'}`,
    `STT_MODEL=${finalValues.STT_MODEL || 'Systran/faster-whisper-large-v3'}`,
    '',
    '# === Voice -- Local TTS (Chatterbox) ===',
    `TTS_URL=${finalValues.TTS_URL || 'http://localhost:8095/v1/tts'}`,
    `TTS_VOICE=${finalValues.TTS_VOICE || 'default'}`,
    '',
    '# === Dashboard API/Auth ===',
    `DASHBOARD_API_TOKEN=${finalValues.DASHBOARD_API_TOKEN || ''}`,
    '',
    '# === Dashboard WebSocket Auth ===',
    `WS_SECRET=${finalValues.WS_SECRET || ''}`,
    '',
    '# === Logging ===',
    `LOG_LEVEL=${finalValues.LOG_LEVEL || 'info'}`,
    '',
    '# === Channels ===',
    `CHANNELS_ENABLED=${finalValues.CHANNELS_ENABLED || 'telegram'}`,
    '',
    '# === Agents ===',
    `ENABLED_AGENTS=${finalValues.ENABLED_AGENTS || ''}`,
    '',
  ]

  // Discord section
  if (enabledChannels.includes('discord') || finalValues.DISCORD_BOT_TOKEN) {
    lines.push(
      '# === Discord ===',
      `DISCORD_BOT_TOKEN=${finalValues.DISCORD_BOT_TOKEN || ''}`,
      `DISCORD_ALLOWED_USER_IDS=${finalValues.DISCORD_ALLOWED_USER_IDS || ''}`,
      '',
    )
  }

  // WhatsApp section
  if (enabledChannels.includes('whatsapp') || finalValues.WHATSAPP_ALLOWED_NUMBERS) {
    lines.push(
      '# === WhatsApp ===',
      `WHATSAPP_ALLOWED_NUMBERS=${finalValues.WHATSAPP_ALLOWED_NUMBERS || ''}`,
      '',
    )
  }

  // Slack section
  if (enabledChannels.includes('slack') || finalValues.SLACK_BOT_TOKEN) {
    lines.push(
      '# === Slack ===',
      `SLACK_BOT_TOKEN=${finalValues.SLACK_BOT_TOKEN || ''}`,
      `SLACK_APP_TOKEN=${finalValues.SLACK_APP_TOKEN || ''}`,
      '',
    )
  }

  // iMessage section
  if (enabledChannels.includes('imessage') || finalValues.IMESSAGE_ALLOWED_HANDLES) {
    lines.push(
      '# === iMessage ===',
      `IMESSAGE_ALLOWED_HANDLES=${finalValues.IMESSAGE_ALLOWED_HANDLES || ''}`,
      '',
    )
  }

  // Security section
  if (configureSecurity || finalValues.SECURITY_PROJECT_PATHS) {
    lines.push(
      '# === Security Scanner ===',
      `SECURITY_PROJECT_PATHS=${finalValues.SECURITY_PROJECT_PATHS || ''}`,
      `SECURITY_DOMAINS=${finalValues.SECURITY_DOMAINS || ''}`,
      `SECURITY_TAILSCALE_NODES=${finalValues.SECURITY_TAILSCALE_NODES || ''}`,
      `SECURITY_GITHUB_OWNER=${finalValues.SECURITY_GITHUB_OWNER || ''}`,
      `SECURITY_EXPECTED_PORTS=${finalValues.SECURITY_EXPECTED_PORTS || '{}'}`,
      `SECURITY_AUTO_FIX_MAX_SEVERITY=${finalValues.SECURITY_AUTO_FIX_MAX_SEVERITY || 'medium'}`,
      '',
    )
  }

  // Social posting (preserve if merging)
  if (
    finalValues.TWITTER_API_KEY ||
    finalValues.LINKEDIN_ACCESS_TOKEN
  ) {
    lines.push(
      '# === Social Posting -- Twitter/X ===',
      `TWITTER_API_KEY=${finalValues.TWITTER_API_KEY || ''}`,
      `TWITTER_API_SECRET=${finalValues.TWITTER_API_SECRET || ''}`,
      `TWITTER_ACCESS_TOKEN=${finalValues.TWITTER_ACCESS_TOKEN || ''}`,
      `TWITTER_ACCESS_SECRET=${finalValues.TWITTER_ACCESS_SECRET || ''}`,
      '',
      '# === Social Posting -- LinkedIn ===',
      `LINKEDIN_ACCESS_TOKEN=${finalValues.LINKEDIN_ACCESS_TOKEN || ''}`,
      `LINKEDIN_PERSON_URN=${finalValues.LINKEDIN_PERSON_URN || ''}`,
      '',
    )
  }

  // Google APIs (preserve if merging)
  if (finalValues.GOOGLE_CLIENT_ID || finalValues.GEMINI_API_KEY) {
    lines.push(
      '# === Google APIs ===',
      `GOOGLE_CLIENT_ID=${finalValues.GOOGLE_CLIENT_ID || ''}`,
      `GOOGLE_CLIENT_SECRET=${finalValues.GOOGLE_CLIENT_SECRET || ''}`,
      `GEMINI_API_KEY=${finalValues.GEMINI_API_KEY || ''}`,
      '',
    )
  }

  // Guard sidecar (preserve if merging)
  if (finalValues.GUARD_SIDECAR_URL) {
    lines.push(
      '# === Guard Sidecar ===',
      `GUARD_SIDECAR_URL=${finalValues.GUARD_SIDECAR_URL || 'http://localhost:8099'}`,
      '',
    )
  }

  // Dashboard URL -- always written; wizard sets it via install-type prompt
  lines.push(
    '# === Dashboard ===',
    `DASHBOARD_URL=${finalValues.DASHBOARD_URL || 'http://localhost:3000'}`,
    '',
  )

  writeFileSync(envPath, lines.join('\n') + '\n')
  ok(`.env written (${doMerge ? 'merged' : 'fresh'})`)
  ok('Generated dashboard auth secrets (DASHBOARD_API_TOKEN + WS_SECRET)')

  // =========================================================================
  // Step 10: Initialize SQLite
  // =========================================================================
  header('Initialize Database')

  const storeDir = join(PROJECT_ROOT, 'store')
  mkdirSync(storeDir, { recursive: true })

  const dbPath = join(storeDir, 'claudepaw.db')
  const isNewDb = !existsSync(dbPath)

  try {
    // Dynamic import of better-sqlite3 (available as a dep)
    const DatabaseMod = await import('better-sqlite3')
    const Database = DatabaseMod.default
    const db = new Database(dbPath)

    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')

    // IMPORTANT: This DDL must stay in sync with:
    //   - src/db.ts (initDatabase) for core tables
    //   - src/paws/db.ts (initPawsTables) for paws tables
    // When adding a new table or column, update ALL THREE locations.
    // Column additions to existing tables also need a migration in src/migrations.ts.
    // Create all core tables (mirrors src/db.ts initDatabase)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        chat_id    TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id     TEXT NOT NULL,
        topic_key   TEXT,
        content     TEXT NOT NULL,
        sector      TEXT NOT NULL CHECK(sector IN ('semantic', 'episodic')),
        salience    REAL NOT NULL DEFAULT 1.0,
        created_at  INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content='memories',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
        INSERT INTO memories_fts(rowid, content)
          VALUES (new.id, new.content);
      END;

      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id          TEXT PRIMARY KEY,
        chat_id     TEXT NOT NULL,
        prompt      TEXT NOT NULL,
        schedule    TEXT NOT NULL,
        next_run    INTEGER NOT NULL,
        last_run    INTEGER,
        last_result TEXT,
        status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused')),
        created_at  INTEGER NOT NULL,
        project_id  TEXT DEFAULT 'default'
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status_next
        ON scheduled_tasks (status, next_run);

      CREATE TABLE IF NOT EXISTS security_findings (
        id TEXT PRIMARY KEY,
        scanner_id TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN ('critical','high','medium','low','info')),
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        target TEXT NOT NULL,
        auto_fixable INTEGER DEFAULT 0,
        auto_fixed INTEGER DEFAULT 0,
        fix_description TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','fixed','acknowledged','false-positive')),
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        resolved_at INTEGER,
        metadata TEXT DEFAULT '{}',
        UNIQUE(scanner_id, title, target)
      );
      CREATE INDEX IF NOT EXISTS idx_findings_status ON security_findings(status);
      CREATE INDEX IF NOT EXISTS idx_findings_severity ON security_findings(severity);

      CREATE TABLE IF NOT EXISTS security_scans (
        id TEXT PRIMARY KEY,
        scanner_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER,
        findings_count INTEGER DEFAULT 0,
        trigger TEXT NOT NULL CHECK(trigger IN ('scheduled','manual'))
      );
      CREATE INDEX IF NOT EXISTS idx_scans_started ON security_scans(started_at DESC);

      CREATE TABLE IF NOT EXISTS security_auto_fixes (
        id TEXT PRIMARY KEY,
        finding_id TEXT NOT NULL,
        scanner_id TEXT NOT NULL,
        action TEXT NOT NULL,
        success INTEGER NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS security_score_history (
        date TEXT PRIMARY KEY,
        score INTEGER NOT NULL,
        critical_count INTEGER DEFAULT 0,
        high_count INTEGER DEFAULT 0,
        medium_count INTEGER DEFAULT 0,
        low_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS guard_events (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN ('BLOCKED', 'FLAGGED', 'PASSED')),
        triggered_layers TEXT,
        block_reason TEXT,
        original_message TEXT,
        sanitized_message TEXT,
        layer_results TEXT,
        latency_ms INTEGER,
        request_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_guard_events_type ON guard_events(event_type, timestamp);
      CREATE INDEX IF NOT EXISTS idx_guard_events_request ON guard_events(request_id);

      CREATE TABLE IF NOT EXISTS newsletter_seen_links (
        url TEXT PRIMARY KEY,
        sent_at INTEGER NOT NULL,
        edition_date TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS newsletter_editions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        lookback_days INTEGER NOT NULL,
        articles_cyber INTEGER NOT NULL DEFAULT 0,
        articles_ai INTEGER NOT NULL DEFAULT 0,
        articles_research INTEGER NOT NULL DEFAULT 0,
        hero_path TEXT,
        html_bytes INTEGER,
        sent_at INTEGER,
        recipient TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS interaction_feedback (
        id            TEXT PRIMARY KEY,
        chat_id       TEXT NOT NULL,
        agent_id      TEXT,
        user_message  TEXT NOT NULL,
        bot_response  TEXT NOT NULL,
        feedback_type TEXT NOT NULL CHECK(feedback_type IN ('correction', 'explicit')),
        feedback_note TEXT,
        created_at    INTEGER NOT NULL,
        consumed      INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_consumed ON interaction_feedback(consumed);
      CREATE INDEX IF NOT EXISTS idx_feedback_agent ON interaction_feedback(agent_id);

      CREATE TABLE IF NOT EXISTS learned_patches (
        id            TEXT PRIMARY KEY,
        agent_id      TEXT,
        feedback_id   TEXT NOT NULL,
        content       TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_patches_agent_expiry ON learned_patches(agent_id, expires_at);

      CREATE TABLE IF NOT EXISTS learned_skills (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid          TEXT NOT NULL UNIQUE,
        agent_id      TEXT,
        title         TEXT NOT NULL,
        content       TEXT NOT NULL,
        source_ids    TEXT NOT NULL DEFAULT '[]',
        effectiveness REAL NOT NULL DEFAULT 1.0,
        created_at    INTEGER NOT NULL,
        last_used     INTEGER,
        status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'retired'))
      );
      CREATE INDEX IF NOT EXISTS idx_skills_agent_status ON learned_skills(agent_id, status);

      CREATE VIRTUAL TABLE IF NOT EXISTS learned_skills_fts USING fts5(
        content,
        content='learned_skills',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON learned_skills BEGIN
        INSERT INTO learned_skills_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON learned_skills BEGIN
        INSERT INTO learned_skills_fts(learned_skills_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE OF content ON learned_skills BEGIN
        INSERT INTO learned_skills_fts(learned_skills_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
        INSERT INTO learned_skills_fts(rowid, content)
          VALUES (new.id, new.content);
      END;

      CREATE TABLE IF NOT EXISTS projects (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL UNIQUE,
        slug         TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        icon         TEXT,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_settings (
        project_id    TEXT PRIMARY KEY REFERENCES projects(id),
        theme_id      TEXT,
        primary_color TEXT,
        accent_color  TEXT,
        sidebar_color TEXT,
        logo_path     TEXT
      );

      CREATE TABLE IF NOT EXISTS chat_projects (
        chat_id    TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS paws (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        name        TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        cron        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','waiting_approval')),
        config      TEXT NOT NULL DEFAULT '{}',
        next_run    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paw_cycles (
        id              TEXT PRIMARY KEY,
        paw_id          TEXT NOT NULL REFERENCES paws(id) ON DELETE CASCADE,
        started_at      INTEGER NOT NULL,
        phase           TEXT NOT NULL DEFAULT 'observe',
        state           TEXT NOT NULL DEFAULT '{}',
        findings        TEXT NOT NULL DEFAULT '[]',
        actions_taken   TEXT NOT NULL DEFAULT '[]',
        report          TEXT,
        completed_at    INTEGER,
        error           TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_paw_cycles_paw_id ON paw_cycles(paw_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_paws_status ON paws(status, next_run);
    `)

    ok(`Database ${isNewDb ? 'created' : 'verified'} at ${dbPath}`)

    // Insert the first project
    const now = Date.now()
    const slug = projectSlug.trim()
    const name = projectName.trim()

    const insertProject = db.prepare(
      `INSERT OR IGNORE INTO projects (id, name, slug, display_name, icon, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    )
    insertProject.run(slug, name, slug, name, now)

    const insertSettings = db.prepare(
      `INSERT OR IGNORE INTO project_settings (project_id, theme_id, primary_color, accent_color, sidebar_color, logo_path)
       VALUES (?, ?, ?, ?, NULL, NULL)`,
    )
    const themeId = themeChoice === 'custom' ? 'custom' : themeChoice.toLowerCase()
    insertSettings.run(slug, themeId, primaryColor, accentColor)

    ok(`Project "${name}" (${slug}) created with ${themeChoice} theme`)

    db.close()
  } catch (err) {
    fail(`Database initialization failed: ${err instanceof Error ? err.message : String(err)}`)
    console.log(dim(`Check permissions on ${storeDir}`))
    process.exit(1)
  }

  // =========================================================================
  // Step 11: Next steps
  // =========================================================================
  header('Setup Complete')
  console.log(`
Next steps:
  1. Build the project:     ${BOLD}npm run build${RESET}
  2. Seed example paws:     ${BOLD}npm run paws:seed${RESET}  ${dim('(optional -- adds starter autonomous agents)')}
  3. Start the bot:         ${BOLD}npm start${RESET}
  4. Open Telegram and send a message to your bot
  5. ${dim('(Optional) Install as launchd service: see CLAUDE.md')}

${dim('Logs: /tmp/claudepaw.log (if running as service)')}
${dim('Dev mode: npm run dev')}
`)
}

// ---------------------------------------------------------------------------
// Entry point with graceful Ctrl+C handling
// ---------------------------------------------------------------------------
main().catch((err) => {
  // @inquirer/prompts throws ExitPromptError on Ctrl+C
  if (err && typeof err === 'object' && 'name' in err && err.name === 'ExitPromptError') {
    console.log(`\n${DIM}Setup cancelled.${RESET}`)
    process.exit(0)
  }
  console.error(`\n${RED}Setup failed:${RESET}`, err)
  process.exit(1)
})
