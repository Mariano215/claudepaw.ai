import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { CREDENTIAL_ENCRYPTION_KEY } from './config.js'
import { logger } from './logger.js'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12

let db: Database.Database
let encryptionKey: Buffer

export function initCredentialStore(database: Database.Database): void {
  db = database

  if (!CREDENTIAL_ENCRYPTION_KEY || CREDENTIAL_ENCRYPTION_KEY.length !== 64) {
    logger.warn(
      'CREDENTIAL_ENCRYPTION_KEY not set or invalid (need 64 hex chars). Credential store disabled.',
    )
    return
  }

  encryptionKey = Buffer.from(CREDENTIAL_ENCRYPTION_KEY, 'hex')
  logger.info('Credential store initialized')
}

function encrypt(plaintext: string): { value: Buffer; iv: Buffer; tag: Buffer } {
  if (!encryptionKey) throw new Error('Credential store not initialized')
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, encryptionKey, iv)
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return { value: encrypted, iv, tag }
}

function decrypt(value: Buffer, iv: Buffer, tag: Buffer): string {
  if (!encryptionKey) throw new Error('Credential store not initialized')
  const decipher = createDecipheriv(ALGORITHM, encryptionKey, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([
    decipher.update(value),
    decipher.final(),
  ])
  return decrypted.toString('utf8')
}

export function setCredential(
  projectId: string,
  service: string,
  key: string,
  plaintext: string,
): void {
  const { value, iv, tag } = encrypt(plaintext)
  const now = Date.now()
  db.prepare(
    `INSERT INTO project_credentials (project_id, service, key, value, iv, tag, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, service, key) DO UPDATE SET
       value = excluded.value,
       iv = excluded.iv,
       tag = excluded.tag,
       updated_at = excluded.updated_at`,
  ).run(projectId, service, key, value, iv, tag, now, now)
}

export function getCredential(
  projectId: string,
  service: string,
  key: string,
): string | null {
  const row = db
    .prepare(
      'SELECT value, iv, tag FROM project_credentials WHERE project_id = ? AND service = ? AND key = ?',
    )
    .get(projectId, service, key) as
    | { value: Buffer; iv: Buffer; tag: Buffer }
    | undefined

  if (!row) return null
  return decrypt(row.value, row.iv, row.tag)
}

export function getServiceCredentials(
  projectId: string,
  service: string,
): Record<string, string> {
  const rows = db
    .prepare(
      'SELECT key, value, iv, tag FROM project_credentials WHERE project_id = ? AND service = ?',
    )
    .all(projectId, service) as Array<{
    key: string
    value: Buffer
    iv: Buffer
    tag: Buffer
  }>

  const result: Record<string, string> = {}
  for (const row of rows) {
    result[row.key] = decrypt(row.value, row.iv, row.tag)
  }
  return result
}

export function listServices(projectId: string): string[] {
  const rows = db
    .prepare(
      'SELECT DISTINCT service FROM project_credentials WHERE project_id = ?',
    )
    .all(projectId) as Array<{ service: string }>
  return rows.map((r) => r.service)
}

export function listAllProjectServices(): Array<{
  projectId: string
  service: string
  keys: string[]
}> {
  const rows = db
    .prepare(
      'SELECT project_id, service, key FROM project_credentials ORDER BY project_id, service, key',
    )
    .all() as Array<{ project_id: string; service: string; key: string }>

  const map = new Map<string, string[]>()
  for (const row of rows) {
    const compositeKey = `${row.project_id}::${row.service}`
    if (!map.has(compositeKey)) map.set(compositeKey, [])
    map.get(compositeKey)!.push(row.key)
  }

  const result: Array<{ projectId: string; service: string; keys: string[] }> = []
  for (const [composite, keys] of map) {
    const [projectId, service] = composite.split('::')
    result.push({ projectId, service, keys })
  }
  return result
}

export function deleteCredential(
  projectId: string,
  service: string,
  key: string,
): void {
  db.prepare(
    'DELETE FROM project_credentials WHERE project_id = ? AND service = ? AND key = ?',
  ).run(projectId, service, key)
}

export function deleteService(projectId: string, service: string): void {
  db.prepare(
    'DELETE FROM project_credentials WHERE project_id = ? AND service = ?',
  ).run(projectId, service)
}
