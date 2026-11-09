/**
 * Pre-publish session probe. Launches a quick Playwright session against
 * the persistent profile and checks whether LinkedIn still treats it as
 * logged in. Returns a verdict the orchestrator uses to decide whether
 * to proceed or alert the operator to re-run bootstrap.
 */

import { chromium } from 'rebrowser-playwright'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../env.js'

const PROFILE_DIR = join(PROJECT_ROOT, 'store', 'linkedin', 'profile')
const READY_MARKER = join(PROJECT_ROOT, 'store', 'linkedin', '.bootstrap-ready')

export type SessionStatus = 'ok' | 'expired' | 'no-profile'

export interface SessionHealth {
  status: SessionStatus
  finalUrl?: string
  details?: string
}

export async function checkLinkedinSession(timeoutMs = 30_000): Promise<SessionHealth> {
  if (!existsSync(PROFILE_DIR) || !existsSync(READY_MARKER)) {
    return {
      status: 'no-profile',
      details: 'Run `npm run linkedin:bootstrap` to create the profile.',
    }
  }

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: true,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-default-browser-check',
        '--no-first-run',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    })

    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    })

    // Brief settle time for client-side redirect to /login if session expired
    await page.waitForTimeout(2000)
    const url = page.url()

    if (url.includes('/login') || url.includes('/checkpoint')) {
      return { status: 'expired', finalUrl: url, details: 'Redirected to login/checkpoint.' }
    }
    if (!url.includes('/feed/') && !url.includes('linkedin.com')) {
      return { status: 'expired', finalUrl: url, details: 'Unexpected landing URL.' }
    }
    return { status: 'ok', finalUrl: url }
  } catch (err) {
    logger.warn({ err }, 'LinkedIn session probe failed')
    return {
      status: 'expired',
      details: `Probe threw: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    if (context) {
      try {
        await context.close()
      } catch {
        // ignore
      }
    }
  }
}
