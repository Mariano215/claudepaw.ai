import { readFileSync } from 'node:fs'
import { CREDENTIAL_ENCRYPTION_KEY, STORE_DIR } from './config.js'
import { initDatabase } from './db.js'
import {
  initCredentialStore,
  setCredential,
  getCredential,
  getServiceCredentials,
  listServices,
  listAllProjectServices,
  deleteCredential,
  deleteService,
} from './credentials.js'

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (!CREDENTIAL_ENCRYPTION_KEY || CREDENTIAL_ENCRYPTION_KEY.length !== 64) {
  console.error(
    'Error: CREDENTIAL_ENCRYPTION_KEY is not set or invalid (need 64 hex chars).',
  )
  process.exit(1)
}

const db = initDatabase()
initCredentialStore(db)

// ---------------------------------------------------------------------------
// ENV import mapping
// ---------------------------------------------------------------------------

const SKIP_VARS = new Set([
  'CLAUDE_CWD',
  'LOG_LEVEL',
  'STORE_DIR',
  'STT_URL',
  'STT_MODEL',
  'TTS_URL',
  'TTS_VOICE',
  'WS_SECRET',
  'CREDENTIAL_ENCRYPTION_KEY',
  'ALLOWED_CHAT_ID',
  'CHANNELS_ENABLED',
])

const EXACT_MAP: Record<string, string> = {
  TWITTER_API_KEY: 'twitter/api_key',
  TWITTER_API_SECRET: 'twitter/api_secret',
  TWITTER_ACCESS_TOKEN: 'twitter/access_token',
  TWITTER_ACCESS_SECRET: 'twitter/access_secret',
  LINKEDIN_CLIENT_ID: 'linkedin/client_id',
  LINKEDIN_CLIENT_SECRET: 'linkedin/client_secret',
  LINKEDIN_ACCESS_TOKEN: 'linkedin/access_token',
  LINKEDIN_REDIRECT_URI: 'linkedin/redirect_uri',
  LINKEDIN_PERSON_URN: 'linkedin/person_urn',
  TELEGRAM_BOT_TOKEN: 'telegram/bot_token',
  GEMINI_API_KEY: 'gemini/api_key',
  GOOGLE_CLIENT_ID: 'google/client_id',
  GOOGLE_CLIENT_SECRET: 'google/client_secret',
  NEWSLETTER_RECIPIENT: 'newsletter/recipient',
  GUARD_SIDECAR_URL: 'guard/sidecar_url',
}

const PREFIX_MAP: Array<[string, string]> = [
  ['META_', 'meta'],
  ['FACEBOOK_', 'meta'],
  ['SHOPIFY_', 'shopify'],
  ['WORDPRESS_', 'wordpress'],
  ['SECURITY_', 'security'],
]

function mapEnvKey(envKey: string): { service: string; key: string } | null {
  if (SKIP_VARS.has(envKey)) return null

  if (EXACT_MAP[envKey]) {
    const [service, key] = EXACT_MAP[envKey].split('/')
    return { service, key }
  }

  for (const [prefix, service] of PREFIX_MAP) {
    if (envKey.startsWith(prefix)) {
      const suffix = envKey.slice(prefix.length).toLowerCase()
      return { service, key: suffix }
    }
  }

  return { service: 'custom', key: envKey.toLowerCase() }
}

// ---------------------------------------------------------------------------
// ENV file parser
// ---------------------------------------------------------------------------

function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

function mask(value: string): string {
  if (value.length <= 4) return '****'
  return value.slice(0, 4) + '*'.repeat(Math.min(value.length - 4, 8))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdSet(args: string[]): void {
  const [project, service, key, value] = args
  if (!project || !service || !key || value === undefined) {
    console.error('Usage: cred-cli set <project> <service> <key> <value>')
    process.exit(1)
  }
  setCredential(project, service, key, value)
  console.log(`Set ${project}/${service}/${key}`)
}

function cmdGet(args: string[]): void {
  const reveal = args.includes('--reveal')
  const filteredArgs = args.filter((a) => a !== '--reveal')
  const [project, service] = filteredArgs

  if (!project || !service) {
    console.error('Usage: cred-cli get <project> <service> [--reveal]')
    process.exit(1)
  }

  const creds = getServiceCredentials(project, service)
  const keys = Object.keys(creds)

  if (keys.length === 0) {
    console.log(`No credentials found for ${project}/${service}`)
    return
  }

  console.log(`${project}/${service}:`)
  for (const k of keys) {
    const display = reveal ? creds[k] : mask(creds[k])
    console.log(`  ${k} = ${display}`)
  }
}

function cmdList(args: string[]): void {
  const project = args[0]

  if (!project) {
    const all = listAllProjectServices()
    if (all.length === 0) {
      console.log('No credentials stored.')
      return
    }
    const byProject = new Map<string, Array<{ service: string; keys: string[] }>>()
    for (const entry of all) {
      if (!byProject.has(entry.projectId)) byProject.set(entry.projectId, [])
      byProject.get(entry.projectId)!.push({ service: entry.service, keys: entry.keys })
    }
    for (const [proj, services] of byProject) {
      console.log(`${proj}:`)
      for (const { service, keys } of services) {
        console.log(`  ${service} (${keys.join(', ')})`)
      }
    }
    return
  }

  const services = listServices(project)
  if (services.length === 0) {
    console.log(`No credentials found for project: ${project}`)
    return
  }
  console.log(`${project}:`)
  for (const service of services) {
    const creds = getServiceCredentials(project, service)
    const keys = Object.keys(creds)
    console.log(`  ${service} (${keys.join(', ')})`)
  }
}

function cmdImport(args: string[]): void {
  const [project, filePath] = args
  if (!project || !filePath) {
    console.error('Usage: cred-cli import <project> <env-file-or->')
    process.exit(1)
  }

  const resolvedPath = filePath === '-' ? '/dev/stdin' : filePath
  let content: string
  try {
    content = readFileSync(resolvedPath, 'utf-8')
  } catch (err) {
    console.error(`Failed to read file: ${resolvedPath}`)
    process.exit(1)
  }

  const envVars = parseEnvContent(content)
  let imported = 0
  let skipped = 0

  for (const [envKey, value] of Object.entries(envVars)) {
    if (!value) {
      skipped++
      continue
    }
    const mapped = mapEnvKey(envKey)
    if (!mapped) {
      console.log(`  skip (bootstrap): ${envKey}`)
      skipped++
      continue
    }
    setCredential(project, mapped.service, mapped.key, value)
    console.log(`  imported: ${envKey} -> ${project}/${mapped.service}/${mapped.key}`)
    imported++
  }

  console.log(`\nDone: ${imported} imported, ${skipped} skipped`)
}

function cmdDelete(args: string[]): void {
  const [project, service, key] = args
  if (!project || !service) {
    console.error('Usage: cred-cli delete <project> <service> [key]')
    process.exit(1)
  }

  if (key) {
    deleteCredential(project, service, key)
    console.log(`Deleted ${project}/${service}/${key}`)
  } else {
    deleteService(project, service)
    console.log(`Deleted all keys for ${project}/${service}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`Usage:
  cred-cli set <project> <service> <key> <value>
  cred-cli get <project> <service> [--reveal]
  cred-cli list [project]
  cred-cli import <project> <env-file-or->
  cred-cli delete <project> <service> [key]`)
}

const [, , command, ...rest] = process.argv

switch (command) {
  case 'set':
    cmdSet(rest)
    break
  case 'get':
    cmdGet(rest)
    break
  case 'list':
    cmdList(rest)
    break
  case 'import':
    cmdImport(rest)
    break
  case 'delete':
    cmdDelete(rest)
    break
  default:
    printUsage()
    process.exit(command ? 1 : 0)
}
