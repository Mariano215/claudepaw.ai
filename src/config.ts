import path from 'node:path'
import { PROJECT_ROOT, readEnvFile } from './env.js'

const env = readEnvFile()
const LEGACY_CLAUDE_CWD = process.cwd()

// --- Telegram ---
export const BOT_TOKEN: string = env.TELEGRAM_BOT_TOKEN ?? ''
export const ALLOWED_CHAT_ID: string = env.ALLOWED_CHAT_ID ?? ''
if (!ALLOWED_CHAT_ID) {
  console.warn('[config] ALLOWED_CHAT_ID not set -- bot will reject all messages until configured')
}
export const MAX_MESSAGE_LENGTH: number = 4096
export const TYPING_REFRESH_MS: number = 4000

// --- Claude ---
// Default to the repo root so agent runtimes can resolve local scripts and dist assets.
// Normalize the legacy parent-directory default because it breaks local CLI paths like dist/integrations/cli.js.
export const CLAUDE_CWD: string =
  !env.CLAUDE_CWD || env.CLAUDE_CWD === LEGACY_CLAUDE_CWD
    ? PROJECT_ROOT
    : env.CLAUDE_CWD

// --- Storage ---
export const STORE_DIR: string = path.join(PROJECT_ROOT, 'store')

// --- STT / TTS ---
export const STT_URL: string =
  env.STT_URL ?? 'http://localhost:8010/v1/audio/transcriptions'
export const STT_MODEL: string =
  env.STT_MODEL ?? 'Systran/faster-whisper-large-v3'

export const TTS_URL: string =
  env.TTS_URL ?? 'http://localhost:8095/v1/tts'
export const TTS_VOICE: string = env.TTS_VOICE ?? 'default'

// --- Security Scanner ---
export const SECURITY_PROJECT_PATHS = (env.SECURITY_PROJECT_PATHS || '').split(',').filter(Boolean)
export const SECURITY_DOMAINS = (env.SECURITY_DOMAINS || '').split(',').filter(Boolean)
export const SECURITY_TAILSCALE_NODES = (env.SECURITY_TAILSCALE_NODES || '').split(',').filter(Boolean)
export const SECURITY_GITHUB_OWNER: string = env.SECURITY_GITHUB_OWNER || ''
export const SECURITY_EXPECTED_PORTS: Record<string, string[]> = (() => {
  try {
    const raw = JSON.parse(env.SECURITY_EXPECTED_PORTS || '{}')
    const result: Record<string, string[]> = {}
    for (const [host, ports] of Object.entries(raw)) {
      result[host] = Array.isArray(ports) ? ports : String(ports).split(',')
    }
    return result
  } catch {
    return {}
  }
})()
export const SECURITY_AUTO_FIX_MAX_SEVERITY: string =
  env.SECURITY_AUTO_FIX_MAX_SEVERITY || 'medium'
export const DASHBOARD_URL: string =
  env.DASHBOARD_URL || ''
export const DASHBOARD_API_TOKEN: string =
  env.DASHBOARD_API_TOKEN || ''
// BOT_API_TOKEN is used for bot-to-dashboard callback authentication.
// When set, the bot authenticates as its own 'bot' role user rather than
// sharing the admin token. Falls back to DASHBOARD_API_TOKEN for backward
// compatibility on deployments that have not yet set BOT_API_TOKEN.
export const BOT_API_TOKEN: string =
  env.BOT_API_TOKEN || env.DASHBOARD_API_TOKEN || ''

// --- WebSocket Auth ---
export const WS_SECRET: string = env.WS_SECRET || ''

// --- Credential Store ---
export const CREDENTIAL_ENCRYPTION_KEY: string = env.CREDENTIAL_ENCRYPTION_KEY ?? ''

// --- Guard Sidecar ---
export const GUARD_SIDECAR_URL: string =
  env.GUARD_SIDECAR_URL ?? 'http://localhost:8099'



// --- Multi-platform channels ---
export const CHANNELS_ENABLED: string[] =
  (env.CHANNELS_ENABLED || 'telegram').split(',').map((s) => s.trim()).filter(Boolean)

// Discord
export const DISCORD_BOT_TOKEN: string = env.DISCORD_BOT_TOKEN ?? ''
export const DISCORD_ALLOWED_USER_IDS: string[] =
  (env.DISCORD_ALLOWED_USER_IDS || '').split(',').filter(Boolean)

// WhatsApp
export const WHATSAPP_AUTH_DIR: string =
  env.WHATSAPP_AUTH_DIR || path.join(PROJECT_ROOT, 'store', 'whatsapp-auth')
export const WHATSAPP_ALLOWED_NUMBERS: string[] =
  (env.WHATSAPP_ALLOWED_NUMBERS || '').split(',').filter(Boolean)

// Slack
export const SLACK_BOT_TOKEN: string = env.SLACK_BOT_TOKEN ?? ''
export const SLACK_APP_TOKEN: string = env.SLACK_APP_TOKEN ?? ''
export const SLACK_ALLOWED_USER_IDS: string[] =
  (env.SLACK_ALLOWED_USER_IDS || '').split(',').filter(Boolean)

// iMessage
export const IMESSAGE_ALLOWED_HANDLES: string[] =
  (env.IMESSAGE_ALLOWED_HANDLES || '').split(',').filter(Boolean)

// Re-export for convenience
export { PROJECT_ROOT }

// --- Memory Layer 4 ---
export const MEMORY_ENABLED: boolean =
  (env.MEMORY_ENABLED ?? 'true') !== 'false'

// Memory v2: unified five-layer agent context. Each flag defaults to true
// (set the env var to the string "false" to disable).
export const MEMORY_V2_ENABLED: boolean =
  (env.MEMORY_V2_ENABLED ?? 'true') !== 'false'
export const MEMORY_V2_EXTRACT_INLINE: boolean =
  (env.MEMORY_V2_EXTRACT_INLINE ?? 'true') !== 'false'
export const MEMORY_V2_EXTRACT_NIGHTLY: boolean =
  (env.MEMORY_V2_EXTRACT_NIGHTLY ?? 'true') !== 'false'
export const MEMORY_V2_EMBEDDINGS: boolean =
  (env.MEMORY_V2_EMBEDDINGS ?? 'true') !== 'false'
export const MEMORY_V2_PROJECT_SNAPSHOT: boolean =
  (env.MEMORY_V2_PROJECT_SNAPSHOT ?? 'true') !== 'false'
export const MEMORY_V2_AGENT_SLICE: boolean =
  (env.MEMORY_V2_AGENT_SLICE ?? 'true') !== 'false'

export const EMBEDDING_PROVIDER: 'ollama' | 'openai' =
  env.EMBEDDING_PROVIDER === 'openai' ? 'openai' : 'ollama'

export const EMBEDDING_MODEL: string =
  env.EMBEDDING_MODEL ??
  (EMBEDDING_PROVIDER === 'openai' ? 'text-embedding-3-small' : 'nomic-embed-text')

export const EMBEDDING_BASE_URL: string =
  env.EMBEDDING_BASE_URL ?? 'http://localhost:11434'

export const EMBEDDING_DIMENSIONS: number =
  EMBEDDING_PROVIDER === 'openai' ? 1536 : 768

export const EXTRACTION_PROVIDER: 'ollama' | 'anthropic' | 'openai' =
  (['ollama', 'anthropic', 'openai'] as const).includes(
    env.EXTRACTION_PROVIDER as 'ollama' | 'anthropic' | 'openai'
  )
    ? (env.EXTRACTION_PROVIDER as 'ollama' | 'anthropic' | 'openai')
    : 'ollama'

export const EXTRACTION_MODEL: string =
  env.EXTRACTION_MODEL ??
  (EXTRACTION_PROVIDER === 'anthropic'
    ? 'claude-haiku-4-5'
    : EXTRACTION_PROVIDER === 'openai'
      ? 'gpt-4o-mini'
      : 'llama3.2:3b')

export const OPENAI_API_KEY: string = env.OPENAI_API_KEY ?? ''
export const ANTHROPIC_API_KEY: string = env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? ''
