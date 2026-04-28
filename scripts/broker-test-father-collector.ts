/**
 * scripts/broker-test-father-collector.ts
 *
 * End-to-end smoke test for `broker-father-broker-inbox` collector.
 *
 * Flow:
 *   1. Resolve broker → google OAuth via existing IntegrationEngine
 *   2. Send a synthetic "pocket listing" email from self to self
 *   3. Apply the pocket/broker label to it
 *   4. Run the collector
 *   5. Print result. Verify the new email shows up in `listings[]`.
 *
 * Use `--no-send` to skip steps 2-3 and just exercise the collector path.
 *
 * Usage:
 *   npx tsx scripts/broker-test-father-collector.ts            # send + run
 *   npx tsx scripts/broker-test-father-collector.ts --no-send  # collector only
 */
import { initDatabase } from '../src/db.js'
import { initCredentialStore } from '../src/credentials.js'
import { CREDENTIAL_ENCRYPTION_KEY } from '../src/config.js'
import { readEnvFile } from '../src/env.js'
import { IntegrationEngine } from '../src/integrations/engine.js'
import { GoogleClient } from '../src/integrations/google/client.js'
import { googleManifest } from '../src/integrations/google/manifest.js'
import { brokerFatherBrokerInboxCollector } from '../src/paws/collectors/broker-father-broker-inbox.js'
import { google } from 'googleapis'

const ACCOUNT = ''
const POCKET_LABEL = 'pocket/broker'
const TARGET_PROJECT = 'broker'

async function findLabelId(gmail: ReturnType<typeof google.gmail>, name: string): Promise<string> {
  const res = await gmail.users.labels.list({ userId: 'me' })
  const found = (res.data.labels ?? []).find((l) => l.name === name)
  if (!found?.id) throw new Error(`Label not found: ${name}. Run scripts/broker-setup-gmail.ts first.`)
  return found.id
}

async function sendTestEmail(gmail: ReturnType<typeof google.gmail>): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const subject = `[broker smoke] Pocket Listing - 9999 Test Avenue`
  const body = [
    'TEST EMAIL from scripts/broker-test-father-collector.ts',
    '',
    'Pocket listing intel:',
    'Address: 9999 Test Avenue, Philadelphia PA 19145',
    'List price: $245,000',
    'Off-market, motivated seller, 3 bed / 1 bath rowhome.',
    'Cash buy preferred. Notes: needs ~$30k rehab, ARV ~$340k.',
    '',
    `Generated at: ${ts}`,
  ].join('\n')

  // RFC 2822 message, base64url-encoded
  const raw = Buffer.from(
    [
      `To: ${ACCOUNT}`,
      `From: ${ACCOUNT}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      body,
    ].join('\r\n'),
    'utf-8',
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const sendRes = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  })
  const messageId = sendRes.data.id
  if (!messageId) throw new Error('messages.send returned no id')
  return messageId
}

async function labelMessage(gmail: ReturnType<typeof google.gmail>, messageId: string, labelId: string): Promise<void> {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  })
}

async function main(): Promise<void> {
  const skipSend = process.argv.includes('--no-send')

  const env = readEnvFile(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
  const clientId = process.env.GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET ?? ''
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing')
  }

  const db = initDatabase()
  initCredentialStore(db)

  const engine = new IntegrationEngine(CREDENTIAL_ENCRYPTION_KEY)
  engine.register(googleManifest)
  const client = new GoogleClient(engine, clientId, clientSecret)
  const auth = await client.ensureFreshToken(TARGET_PROJECT, ACCOUNT)
  const gmail = google.gmail({ version: 'v1', auth })

  if (!skipSend) {
    const labelId = await findLabelId(gmail, POCKET_LABEL)
    console.log(`[1/3] resolved label id: ${labelId}`)

    const msgId = await sendTestEmail(gmail)
    console.log(`[2/3] sent test email: id=${msgId}`)

    // Gmail's label-after-send timing is usually instant but give it a beat
    // so the search index sees both the message and the label binding.
    await new Promise((r) => setTimeout(r, 1500))
    await labelMessage(gmail, msgId, labelId)
    console.log(`[3/3] applied label ${POCKET_LABEL}`)
  } else {
    console.log('skipping send (--no-send)')
  }

  // Brief settle so Gmail search sees the new label binding.
  await new Promise((r) => setTimeout(r, 2000))

  const ctx = {
    pawId: 're-father-broker-pocket-feed',
    projectId: TARGET_PROJECT,
    args: {},
  }
  const result = await brokerFatherBrokerInboxCollector(ctx as any)

  console.log('\n=== collector result ===')
  console.log(JSON.stringify(result, null, 2))

  const listings = (result.raw_data as any)?.listings ?? []
  const reachable = (result.raw_data as any)?.gmail_reachable
  const errs = result.errors?.length ?? 0
  console.error(`\n[summary] gmail_reachable=${reachable} listings=${listings.length} errors=${errs}`)
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
