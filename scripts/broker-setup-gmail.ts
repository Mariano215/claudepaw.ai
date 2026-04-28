/**
 * scripts/broker-setup-gmail.ts
 *
 * One-shot Step 8 bootstrapper for Paw Broker.
 *
 * What it does (idempotent — safe to re-run):
 *   1. Insert `broker` row into `projects` table if missing
 *   2. Replicate `` google credentials from the `default`
 *      project into `broker`. Encryption is project-id-agnostic (no AAD), so
 *      copying the encrypted (value, iv, tag) blobs across project_ids works.
 *   3. Insert installed_integrations row for broker → google → 
 *   4. Create Gmail label `pocket/broker` if it doesn't already exist
 *
 * Why a script and not the cpaw CLI:
 *   The plan called for `cpaw integrations connect --project broker --service google`,
 *   but the current cpaw CLI surface is `cpaw service google <module> <command>` and
 *   has no `connect` subcommand. The OAuth bootstrap flow lives behind the dashboard.
 *   Since the google account is already connected for the default project,
 *   the cleanest path is to replicate those tokens to broker so
 *   `broker-father-broker-inbox` no longer falls back through the project chain.
 *
 *   Future v2: extend cpaw CLI with an `integrations clone --from default --to broker
 *   --service google` subcommand and retire this script.
 *
 * Usage: npx tsx scripts/broker-setup-gmail.ts
 */
import { initDatabase, getDb } from '../src/db.js'
import { initCredentialStore } from '../src/credentials.js'
import { CREDENTIAL_ENCRYPTION_KEY } from '../src/config.js'
import { readEnvFile } from '../src/env.js'
import { IntegrationEngine } from '../src/integrations/engine.js'
import { GoogleClient } from '../src/integrations/google/client.js'
import { googleManifest } from '../src/integrations/google/manifest.js'
import { google } from 'googleapis'
import { logger } from '../src/logger.js'

const SOURCE_PROJECT = 'default'
const TARGET_PROJECT = 'broker'
const ACCOUNT = ''
const SERVICE_KEY = `google:${ACCOUNT}`
const POCKET_LABEL = 'pocket/broker'

async function main(): Promise<void> {
  const env = readEnvFile(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
  const clientId = process.env.GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET ?? ''
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing in env or .env file')
  }

  const db = initDatabase()
  initCredentialStore(db)

  // ---- 1. broker row in projects ----
  const projectsRow = db
    .prepare('SELECT id FROM projects WHERE id = ?')
    .get(TARGET_PROJECT) as { id: string } | undefined

  if (!projectsRow) {
    const now = Date.now()
    db.prepare(`
      INSERT INTO projects (id, name, slug, display_name, icon, created_at, status, updated_at)
      VALUES (?, ?, ?, ?, NULL, ?, 'active', ?)
    `).run(TARGET_PROJECT, 'Paw Broker', TARGET_PROJECT, 'Paw Broker', now, now)
    console.log(`[1/4] inserted projects row: ${TARGET_PROJECT}`)
  } else {
    console.log(`[1/4] projects row already present: ${TARGET_PROJECT}`)
  }

  // ---- 2. replicate google credentials default → broker ----
  // Read raw encrypted blobs and copy verbatim. Encryption has no AAD so the
  // ciphertext decrypts identically regardless of project_id.
  const sourceRows = db.prepare(`
    SELECT key, value, iv, tag, created_at
    FROM project_credentials
    WHERE project_id = ? AND service = ?
  `).all(SOURCE_PROJECT, SERVICE_KEY) as Array<{
    key: string
    value: Buffer
    iv: Buffer
    tag: Buffer
    created_at: number
  }>

  if (sourceRows.length === 0) {
    throw new Error(`No google credentials found for project '${SOURCE_PROJECT}' / ${SERVICE_KEY}. Connect default first.`)
  }

  const insertCred = db.prepare(`
    INSERT INTO project_credentials (project_id, service, key, value, iv, tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, service, key) DO UPDATE SET
      value = excluded.value,
      iv = excluded.iv,
      tag = excluded.tag,
      updated_at = excluded.updated_at
  `)

  const tx = db.transaction(() => {
    const now = Date.now()
    for (const row of sourceRows) {
      insertCred.run(TARGET_PROJECT, SERVICE_KEY, row.key, row.value, row.iv, row.tag, row.created_at, now)
    }
  })
  tx()
  console.log(`[2/4] replicated ${sourceRows.length} google credential rows: ${SOURCE_PROJECT} → ${TARGET_PROJECT}`)

  // ---- 3. installed_integrations row ----
  const existingInstall = db
    .prepare('SELECT id FROM installed_integrations WHERE project_id = ? AND integration_id = ?')
    .get(TARGET_PROJECT, 'google') as { id: number } | undefined

  if (!existingInstall) {
    const now = Date.now()
    db.prepare(`
      INSERT INTO installed_integrations (project_id, integration_id, status, account, last_verified_at, installed_at)
      VALUES (?, 'google', 'connected', ?, ?, ?)
    `).run(TARGET_PROJECT, ACCOUNT, now, now)
    console.log(`[3/4] inserted installed_integrations row: ${TARGET_PROJECT} → google → ${ACCOUNT}`)
  } else {
    console.log(`[3/4] installed_integrations row already present`)
  }

  // ---- 4. Gmail label ----
  const engine = new IntegrationEngine(CREDENTIAL_ENCRYPTION_KEY)
  engine.register(googleManifest)
  const client = new GoogleClient(engine, clientId, clientSecret)
  const auth = await client.ensureFreshToken(TARGET_PROJECT, ACCOUNT)

  const gmail = google.gmail({ version: 'v1', auth })
  const labelsRes = await gmail.users.labels.list({ userId: 'me' })
  const allLabels = labelsRes.data.labels ?? []
  const existing = allLabels.find((l) => l.name === POCKET_LABEL)
  if (existing) {
    console.log(`[4/4] Gmail label already exists: ${POCKET_LABEL} (id=${existing.id})`)
  } else {
    const created = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: POCKET_LABEL,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      },
    })
    console.log(`[4/4] created Gmail label: ${POCKET_LABEL} (id=${created.data.id})`)
  }

  console.log('\nbroker → google integration ready. Next:')
  console.log('  - Send a test pocket-listing email to  with label pocket/broker')
  console.log('  - Force-run: tsx src/paws/cli.ts run re-father-broker-pocket-feed')
  console.log('  - Verify father_broker_listings rows + Telegram digest at @PawBrokerBot')
}

main().catch((err) => {
  logger.error({ err }, 'broker-setup-gmail failed')
  console.error('FAILED:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
