import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Load .env file if present (no dotenv dependency needed).
// Order:
//   1. server/.env  (production deploy on Hostinger has this)
//   2. ../.env      (local dev: shared with the bot at the project root)
// First match wins per key; second file fills in any keys still missing.
// This module MUST be imported BEFORE any module that reads process.env.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const candidates = [
  path.join(__dirname, '..', '.env'),       // server/.env
  path.join(__dirname, '..', '..', '.env'), // <repo root>/.env (shared with bot)
]

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return
  try {
    const envContent = readFileSync(filePath, 'utf8')
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 1) continue
      const key = trimmed.slice(0, eqIdx)
      if (!process.env[key]) {
        // Strip optional surrounding quotes for tolerance with shells/dotenv
        let value = trimmed.slice(eqIdx + 1)
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        process.env[key] = value
      }
    }
  } catch {
    /* unreadable env file is non-fatal */
  }
}

for (const candidate of candidates) loadEnvFile(candidate)

// Exported so other modules (health endpoint, dashboard) can surface this
// condition instead of silently returning empty credentials.
export const CREDENTIAL_KEY_MISSING = !process.env.CREDENTIAL_ENCRYPTION_KEY

if (CREDENTIAL_KEY_MISSING) {
  // Fail loud: the server refuses to boot without this key. Every integration
  // depends on decrypting credentials from the bot DB, and a missing key
  // silently breaks metric collection, OAuth refresh, and social posting.
  // If you need to run in a degraded mode for testing, set
  // ALLOW_MISSING_CREDENTIAL_KEY=1 to downgrade this to a warning.
  const allowMissing = process.env.ALLOW_MISSING_CREDENTIAL_KEY === '1'
  const msg = '[env] CREDENTIAL_ENCRYPTION_KEY is not set. Credential decryption will fail and every integration will report as missing credentials.'
  if (allowMissing) {
    // eslint-disable-next-line no-console
    console.warn(`${msg} ALLOW_MISSING_CREDENTIAL_KEY=1 set, continuing in degraded mode.`)
  } else {
    // eslint-disable-next-line no-console
    console.error(`${msg} Aborting startup. Set CREDENTIAL_ENCRYPTION_KEY in .env or pass ALLOW_MISSING_CREDENTIAL_KEY=1 to override.`)
    process.exit(1)
  }
}
