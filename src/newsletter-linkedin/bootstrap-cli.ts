/**
 * One-shot CLI that opens Chromium headed, navigates to linkedin.com/login,
 * and waits for the user to log in interactively (including 2FA). On
 * successful landing at /feed/, persists a "ready" marker file so the
 * publisher knows the profile is good.
 *
 * Usage:
 *   npm run linkedin:bootstrap
 *
 * Re-run when the LinkedIn session expires (typically every few weeks).
 */

import { chromium } from 'rebrowser-playwright'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from '../env.js'

const PROFILE_DIR = join(PROJECT_ROOT, 'store', 'linkedin', 'profile')
const READY_MARKER = join(PROJECT_ROOT, 'store', 'linkedin', '.bootstrap-ready')

const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--no-default-browser-check',
  '--no-first-run',
  '--password-store=basic',
]
const IGNORE_DEFAULT_ARGS = ['--enable-automation', '--enable-blink-features=IdleDetection']

async function main() {
  console.log('LinkedIn bootstrap: opening Chromium...')
  console.log(`Profile dir: ${PROFILE_DIR}`)

  if (!existsSync(PROFILE_DIR)) {
    mkdirSync(PROFILE_DIR, { recursive: true })
  }
  if (!existsSync(dirname(READY_MARKER))) {
    mkdirSync(dirname(READY_MARKER), { recursive: true })
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    deviceScaleFactor: 2,
    args: LAUNCH_ARGS,
    ignoreDefaultArgs: IGNORE_DEFAULT_ARGS,
  })

  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' })

  console.log('Waiting for you to log in + complete 2FA...')
  console.log('(Window will close automatically once we detect /feed/.)')

  const timeoutMs = 10 * 60_000 // 10 minutes for the human flow
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const url = page.url()
    if (url.includes('/feed/') || url.match(/linkedin\.com\/(in|home|notifications)/)) {
      break
    }
    await page.waitForTimeout(2000)
  }

  const finalUrl = page.url()
  if (!finalUrl.includes('linkedin.com') || finalUrl.includes('/login')) {
    console.error('Bootstrap timed out before login completed.')
    await context.close()
    process.exit(1)
  }

  writeFileSync(
    READY_MARKER,
    JSON.stringify({ ready_at: Date.now(), landed_at: finalUrl }, null, 2),
  )
  console.log(`Profile ready. Marker: ${READY_MARKER}`)
  console.log('Closing browser. You can now run `npm run linkedin:smoke`.')
  await context.close()
}

main().catch((err) => {
  console.error('Bootstrap failed:', err)
  process.exit(1)
})
