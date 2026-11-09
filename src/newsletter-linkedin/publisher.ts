/**
 * The Playwright flow that drives the LinkedIn article editor.
 *
 * Selectors below are best-effort as of May 2026 and MUST be re-verified
 * against the live DOM during Phase 2B (real-LinkedIn DRY_RUN iteration).
 * Each selector has a fallback list — the helper `firstWorking()` walks
 * the list and returns the first locator that resolves within a timeout.
 *
 * The Quill body is injected via a page-side function passed to
 * `page.evaluate()` that walks React Fiber to find the Quill 2.x
 * instance, then calls `quill.setContents(delta, 'api')` to produce
 * trusted edits. Naive `page.fill('.ql-editor', ...)` does NOT work as
 * of the early-2026 ProseMirror -> Quill migration.
 */

import { chromium } from 'rebrowser-playwright'
import type { BrowserContext, Page, Locator } from 'rebrowser-playwright'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../env.js'
import { logger } from '../logger.js'
import type { PublishOptions, PublishResult, QuillDeltaOp } from './types.js'

const PROFILE_DIR = join(PROJECT_ROOT, 'store', 'linkedin', 'profile')
const SCREENSHOT_DIR = join(PROJECT_ROOT, 'store', 'newsletter', 'linkedin')

const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--no-default-browser-check',
  '--no-first-run',
  '--password-store=basic',
]
const IGNORE_DEFAULT_ARGS = ['--enable-automation', '--enable-blink-features=IdleDetection']

// ---------------------------------------------------------------------------
// Selector candidates (most-specific first, broadest last). All must be
// re-verified live before turning off DRY_RUN.
// ---------------------------------------------------------------------------

const SEL = {
  shareBoxButton: [
    'button.share-box-feed-entry__top-bar',
    'div[data-placeholder="Start a post"]',
    'button:has-text("Start a post")',
    '[aria-label="Start a post"]',
  ],
  writeArticleLink: [
    'a[href*="/article/"]',
    'a:has-text("Write article")',
    'button:has-text("Write article")',
  ],
  publisherDropdown: [
    'button[aria-label*="newsletter" i]',
    'button[aria-label*="Publishing" i]',
    '[data-control-name="publishing_choose_newsletter"]',
  ],
  newsletterOption: (name: string) => [
    `[role="menuitem"]:has-text("${name}")`,
    `li:has-text("${name}")`,
  ],
  coverFileInput: [
    'input[type="file"][accept*="image"]',
    'input[type="file"]',
  ],
  titleInput: [
    '[aria-label="Title"]',
    '[placeholder*="Title"]',
    'h1[contenteditable="true"]',
    '.article-editor-headline__title',
  ],
  bodyEditor: [
    '.ql-editor[contenteditable="true"]',
    '.ql-container',
    '[role="textbox"][aria-multiline="true"]',
  ],
  nextButton: [
    'button:has-text("Next")',
    '[aria-label="Next"]',
    '.share-actions__primary-action',
  ],
  publishButton: [
    'button:has-text("Publish")',
    '[aria-label*="Publish"]',
    '.publish-menu__publish-btn',
    '.share-actions__primary-action',
  ],
  onboardingModalDismiss: [
    'button[aria-label="Dismiss"]',
    'button:has-text("Skip for now")',
    'button:has-text("Not now")',
  ],
} as const

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min)) + min
}

async function humanPause(page: Page): Promise<void> {
  await page.waitForTimeout(rand(800, 2000))
}

async function firstWorking(
  page: Page,
  selectors: readonly string[],
  timeout = 5000,
): Promise<Locator | null> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first()
      await loc.waitFor({ state: 'visible', timeout })
      return loc
    } catch {
      // try next
    }
  }
  return null
}

async function screenshot(page: Page, label: string, editionId: string): Promise<string> {
  ensureDir(SCREENSHOT_DIR)
  const path = join(SCREENSHOT_DIR, `${editionId}-${label}-${Date.now()}.png`)
  try {
    await page.screenshot({ path, fullPage: false })
  } catch (err) {
    logger.warn({ err, path }, 'Screenshot capture failed')
  }
  return path
}

// ---------------------------------------------------------------------------
// Page-side Quill injector. Passed as a function to page.evaluate() —
// Playwright serializes the function source and runs it in the page
// context. NO eval() is used.
// ---------------------------------------------------------------------------

function injectQuillContent(ops: unknown): { ok: boolean; error?: string; length?: number } {
  function findQuill(): unknown {
    const container = document.querySelector('.ql-container') as
      | (HTMLElement & { __quill?: unknown })
      | null
    if (!container) return null
    if (container.__quill) return container.__quill
    const key = Object.keys(container).find((k) => k.startsWith('__reactFiber'))
    type Fiber = { memoizedProps?: { quill?: unknown }; stateNode?: { quill?: unknown }; return?: Fiber }
    let fiber: Fiber | null = key
      ? ((container as unknown as Record<string, Fiber>)[key] ?? null)
      : null
    while (fiber) {
      const props = fiber.memoizedProps || {}
      const state = fiber.stateNode || {}
      if (props.quill) return props.quill
      if (state.quill) return state.quill
      fiber = fiber.return ?? null
    }
    return null
  }
  const quill = findQuill() as
    | { setContents: (ops: unknown, source: string) => void; getLength: () => number }
    | null
  if (!quill) {
    return { ok: false, error: 'Quill instance not found via .ql-container or React fiber walk' }
  }
  quill.setContents(ops, 'api')
  return { ok: true, length: quill.getLength() }
}

// ---------------------------------------------------------------------------
// Main publisher
// ---------------------------------------------------------------------------

export interface PublishInput {
  editionId: string
  title: string
  coverImagePath: string
  delta: QuillDeltaOp[]
  /** LinkedIn newsletter publication name to select in the dropdown. */
  newsletterName: string
}

export async function publishToLinkedin(
  input: PublishInput,
  opts: PublishOptions = { dryRun: true },
): Promise<PublishResult> {
  const startedAt = Date.now()
  let step = 'launch'
  let context: BrowserContext | null = null
  let lastScreenshot: string | undefined

  const finish = (
    ok: boolean,
    extras: Partial<PublishResult> = {},
  ): PublishResult => ({
    ok,
    step,
    durationMs: Date.now() - startedAt,
    screenshotPath: lastScreenshot,
    ...extras,
  })

  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: opts.headless ?? false,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      deviceScaleFactor: 2,
      args: LAUNCH_ARGS,
      ignoreDefaultArgs: IGNORE_DEFAULT_ARGS,
    })
    const page = context.pages()[0] ?? (await context.newPage())

    // 1. Navigate directly to the article editor.
    //    Verified May 2026: linkedin.com/article/new/ auto-creates a draft
    //    and lands on /article/edit/<id>/. Avoids the share-box modal whose
    //    interop-outlet shadow DOM intercepts pointer events on /feed/.
    step = 'navigate-editor'
    await page.goto('https://www.linkedin.com/article/new/', { waitUntil: 'domcontentloaded' })
    if (page.url().includes('/login') || page.url().includes('/checkpoint')) {
      lastScreenshot = await screenshot(page, 'session-expired', input.editionId)
      return finish(false, { errorMessage: 'LinkedIn session expired — re-run bootstrap' })
    }
    await humanPause(page)

    // 2. Wait for Quill editor to load (post-redirect to /article/edit/<id>/)
    step = 'await-editor'
    const editor = await firstWorking(page, SEL.bodyEditor, 20_000)
    if (!editor) {
      lastScreenshot = await screenshot(page, 'no-editor', input.editionId)
      return finish(false, { errorMessage: 'Quill editor never loaded' })
    }
    await humanPause(page)

    // 4. Select newsletter publication (skip silently if dropdown not visible —
    //    single-newsletter accounts auto-select)
    step = 'select-newsletter'
    const dropdown = await firstWorking(page, SEL.publisherDropdown, 2000)
    if (dropdown) {
      await dropdown.click()
      await humanPause(page)
      const option = await firstWorking(page, SEL.newsletterOption(input.newsletterName), 3000)
      if (option) {
        await option.click()
      } else {
        logger.warn(
          { newsletter: input.newsletterName },
          'Newsletter dropdown opened but option not found; continuing',
        )
        await page.keyboard.press('Escape')
      }
      await humanPause(page)
    }

    // 5. Upload cover image
    step = 'upload-cover'
    if (input.coverImagePath && existsSync(input.coverImagePath)) {
      const fileInput = page.locator(SEL.coverFileInput[0]).first()
      try {
        await fileInput.setInputFiles(input.coverImagePath)
        await humanPause(page)
      } catch (err) {
        logger.warn({ err }, 'Cover upload via input failed; continuing without cover')
      }
    }

    // 6. Fill title (human-typing rhythm; short text, low risk)
    step = 'fill-title'
    const titleLoc = await firstWorking(page, SEL.titleInput, 5000)
    if (!titleLoc) {
      lastScreenshot = await screenshot(page, 'no-title-input', input.editionId)
      return finish(false, { errorMessage: 'Title input not found' })
    }
    await titleLoc.click()
    await page.keyboard.type(input.title, { delay: rand(40, 120) })
    await humanPause(page)

    // 7. Inject body via Quill API (no eval — function passed directly)
    step = 'inject-body'
    const injectResult = (await page.evaluate(injectQuillContent, input.delta)) as {
      ok: boolean
      error?: string
      length?: number
    }
    if (!injectResult.ok) {
      lastScreenshot = await screenshot(page, 'quill-inject-failed', input.editionId)
      return finish(false, { errorMessage: `Quill injection failed: ${injectResult.error}` })
    }
    logger.info({ injectedLength: injectResult.length }, 'Quill body injected')
    await humanPause(page)

    // 8. Handle first-edition onboarding modal if present
    const onboardingDismiss = await firstWorking(page, SEL.onboardingModalDismiss, 1500)
    if (onboardingDismiss) {
      logger.info('Dismissing first-edition onboarding modal')
      await onboardingDismiss.click()
      await humanPause(page)
    }

    if (opts.dryRun) {
      step = 'dry-run-await-autosave'
      // LinkedIn auto-saves drafts on a debounced interval (~3-5s after the
      // last edit). Blur the body to trigger immediate save, then wait for
      // the "Saved" indicator before closing. If the indicator never
      // appears, fall back to a fixed wait so the draft has time to persist.
      try {
        await page.locator('body').click({ position: { x: 10, y: 10 }, timeout: 2000 })
      } catch {
        // ignore — click-elsewhere is best-effort
      }
      const savedHints = [
        'text=/Saved.*ago/i',
        'text=/Draft saved/i',
        'text=/^Saved$/i',
        '[aria-label*="Saved"]',
      ]
      const savedLoc = await firstWorking(page, savedHints, 12_000)
      if (!savedLoc) {
        logger.warn('No autosave indicator detected; waiting 8s fallback')
        await page.waitForTimeout(8000)
      } else {
        logger.info('LinkedIn autosave indicator detected — draft persisted')
      }
      lastScreenshot = await screenshot(page, 'dry-run-ready', input.editionId)
      step = 'dry-run-stop'
      return finish(true, { errorMessage: undefined })
    }

    // 9. Click Next -> Publish dialog
    step = 'click-next'
    const nextBtn = await firstWorking(page, SEL.nextButton, 5000)
    if (!nextBtn) {
      lastScreenshot = await screenshot(page, 'no-next-button', input.editionId)
      return finish(false, { errorMessage: 'Next button not found' })
    }
    await nextBtn.click()
    await humanPause(page)

    // 10. Click Publish in the dialog
    step = 'click-publish'
    const publishBtn = await firstWorking(page, SEL.publishButton, 5000)
    if (!publishBtn) {
      lastScreenshot = await screenshot(page, 'no-publish-button', input.editionId)
      return finish(false, { errorMessage: 'Publish button not found' })
    }
    await publishBtn.click()

    // 11. Verify success: race URL change or toast
    step = 'verify-success'
    let publishedUrl: string | undefined
    try {
      await Promise.race([
        page
          .waitForURL((url) => url.toString().includes('/pulse/'), { timeout: 30_000 })
          .then(() => {
            publishedUrl = page.url()
          }),
        page
          .waitForSelector('[role="alert"]:has-text("publish"), [role="alert"]:has-text("post")', {
            timeout: 30_000,
          })
          .then(() => {
            publishedUrl = page.url()
          }),
      ])
    } catch {
      lastScreenshot = await screenshot(page, 'publish-verify-timeout', input.editionId)
      return finish(false, { errorMessage: 'Publish verification timed out' })
    }

    lastScreenshot = await screenshot(page, 'published-ok', input.editionId)
    return finish(true, { publishedUrl })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    logger.error({ err, step }, 'Publisher threw')
    return finish(false, { errorMessage })
  } finally {
    if (context) {
      try {
        await context.close()
      } catch {
        /* ignore */
      }
    }
  }
}
