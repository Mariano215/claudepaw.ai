/**
 * Rotate MarMacClaudeBot Telegram bot token after BotFather revoke.
 * Updates local bot DB, syncs to dashboard server, then asks for restart.
 *
 * Usage:
 *   npx tsx scripts/rotate-marmac-token.ts <new-token>
 *
 * After running, restart ClaudePaw:
 *   launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claudepaw.app.plist
 *   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudepaw.app.plist
 */
import Database from 'better-sqlite3'
import { initCredentialStore, setCredential, getCredential } from '../src/credentials.js'
import * as https from 'https'

const newToken = process.argv[2]
if (!newToken || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(newToken)) {
  console.error('Usage: npx tsx scripts/rotate-marmac-token.ts <new-token>')
  console.error('Token must look like 1234567890:ABC-DEF1234ghIkl-zyx57W2v1u123ew11')
  process.exit(1)
}

const PROJECT_ID = 'default'
const SERVICE = 'telegram'
const KEY = 'bot_token'

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (r) => {
        let d = ''
        r.on('data', (c) => (d += c))
        r.on('end', () => {
          try {
            resolve(JSON.parse(d))
          } catch {
            reject(new Error(`Bad JSON: ${d}`))
          }
        })
      })
      .on('error', reject)
  })
}

async function main() {
  // 1. Verify new token works with Telegram
  console.log('1. Verifying new token via getMe ...')
  const me = await fetchJson(`https://api.telegram.org/bot${newToken}/getMe`)
  if (!me.ok) {
    console.error('FAIL — Telegram rejected new token:', me)
    process.exit(1)
  }
  if (me.result.username !== 'MarMacClaudeBot') {
    console.error(`FAIL — Wrong bot. Expected MarMacClaudeBot, got @${me.result.username}`)
    process.exit(1)
  }
  console.log(`   OK — @${me.result.username} (id ${me.result.id})`)

  // 2. Update local bot DB
  console.log('2. Updating bot DB credential (store/claudepaw.db) ...')
  const db = new Database('store/claudepaw.db')
  initCredentialStore(db)
  const oldToken = getCredential(PROJECT_ID, SERVICE, KEY)
  console.log(`   Old token: ${oldToken ? oldToken.slice(0, 10) + '...' : '(none)'}`)
  setCredential(PROJECT_ID, SERVICE, KEY, newToken)
  const readBack = getCredential(PROJECT_ID, SERVICE, KEY)
  if (readBack !== newToken) {
    console.error('FAIL — Read-back mismatch after write')
    process.exit(1)
  }
  console.log(`   New token: ${newToken.slice(0, 10)}...`)
  db.close()

  // 3. Sync to Hostinger dashboard DB via /api/v1/credentials
  console.log('3. Syncing to Hostinger dashboard server ...')
  const adminToken = process.env.DASHBOARD_API_TOKEN
  if (!adminToken) {
    console.warn('   SKIP — DASHBOARD_API_TOKEN env var not set.')
    console.warn('   Bot DB has new token. Sync server side via dashboard UI or set env var and rerun.')
  } else {
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'localhost',
            port: 3000,
            path: '/api/v1/credentials',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${adminToken}`,
            },
            rejectUnauthorized: false,
          },
          (r) => {
            let d = ''
            r.on('data', (c) => (d += c))
            r.on('end', () => resolve(`${r.statusCode} ${d}`))
          },
        )
        req.on('error', reject)
        req.write(JSON.stringify({ project_id: PROJECT_ID, service: SERVICE, key: KEY, value: newToken }))
        req.end()
      })
      console.log('   Remote response:', result)
    } catch (err) {
      console.error('   Remote sync failed:', (err as Error).message)
    }
  }

  console.log('\nDone. Next steps:')
  console.log('  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.claudepaw.app.plist')
  console.log('  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudepaw.app.plist')
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
