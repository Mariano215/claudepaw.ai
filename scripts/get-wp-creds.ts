// Fetch decrypted project credentials from the local credential store.
//
// Usage:
//   tsx scripts/get-wp-creds.ts <project> <service> [<key>...]
//
// Examples:
//   tsx scripts/get-wp-creds.ts my-project wordpress url user app_password
//   tsx scripts/get-wp-creds.ts my-project gemini api_key
//
// If no keys are listed, prints every key stored under the given
// (project, service) pair. Keys are NOT hardcoded so this file stays
// project-agnostic and safe to publish in the OSS mirror.

import Database from 'better-sqlite3'
import { createDecipheriv } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.resolve(__dirname, '../store/claudepaw.db')
const ALGORITHM = 'aes-256-gcm'

const [, , project, service, ...keys] = process.argv
if (!project || !service) {
  console.error('Usage: tsx scripts/get-wp-creds.ts <project> <service> [<key>...]')
  process.exit(1)
}

const envPath = path.resolve(__dirname, '../.env')
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('=').map(x => x.trim()))
)
const ENCRYPTION_KEY = Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY, 'hex')

function decrypt(value: Buffer, iv: Buffer, tag: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(value), decipher.final()]).toString('utf8')
}

const db = new Database(DB_PATH, { readonly: true })

function getCred(projectId: string, svc: string, key: string): string | null {
  const row = db.prepare(
    'SELECT value, iv, tag FROM project_credentials WHERE project_id = ? AND service = ? AND key = ?'
  ).get(projectId, svc, key) as { value: Buffer; iv: Buffer; tag: Buffer } | undefined
  if (!row) return null
  return decrypt(row.value, row.iv, row.tag)
}

function listKeys(projectId: string, svc: string): string[] {
  const rows = db.prepare(
    'SELECT key FROM project_credentials WHERE project_id = ? AND service = ? ORDER BY key'
  ).all(projectId, svc) as Array<{ key: string }>
  return rows.map(r => r.key)
}

const selected = keys.length > 0 ? keys : listKeys(project, service)
if (selected.length === 0) {
  console.error(`No credentials found for project=${project} service=${service}`)
  process.exit(2)
}
for (const k of selected) {
  const v = getCred(project, service, k)
  console.log(`${k.toUpperCase()}:`, v)
}
