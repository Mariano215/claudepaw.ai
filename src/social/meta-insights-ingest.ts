/**
 * Example Company social analytics ingest.
 *
 * Pulls daily follower + engagement numbers from the Meta Graph API and appends
 * a dated snapshot to the `Social_Media_Data` Google Sheet (Daily Overview tab),
 * which the weekly social report already reads. Deterministic, no LLM.
 *
 * v1 scope: follower counts (FB + IG) and IG per-post engagement. Reach /
 * impressions / profile views are intentionally left blank: FB's page_impressions
 * family was deprecated by Meta, and IG insights need the instagram_manage_insights
 * scope which the app does not yet expose. Wire those columns in once the scope
 * lands (see fillReachColumns note below).
 *
 * Runs in the bot's launchd context (same pattern other in-process background
 * syncs use) so it has the disk + credential access that standalone launchd+bash
 * jobs lack on the external volume.
 * Disable with FOP_SOCIAL_INGEST_ENABLED=false.
 */
import { resolveMetaConfig } from './resolve.js'
import { SheetsModule } from '../integrations/google/sheets.js'
import { GoogleClient } from '../integrations/google/client.js'
import { IntegrationEngine } from '../integrations/engine.js'
import { googleManifest } from '../integrations/google/manifest.js'
import { CREDENTIAL_ENCRYPTION_KEY } from '../config.js'
import { logger } from '../logger.js'

const SHEET = 'YOUR_SHEET_ID_HERE'
const PROJECT = 'example-company'
const GOOGLE_ACCOUNT = 'your-account@example.com'
const API = 'https://graph.facebook.com/v22.0'
const FB_PLATFORM = 'Example Company'
const IG_PLATFORM = 'Instagram'

const INTERVAL_MS = 60 * 60 * 1000 // hourly tick; idempotency guard makes it effectively daily
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000
let timer: NodeJS.Timeout | null = null

async function graphGet(path: string, params: string, token: string): Promise<any> {
  const res = await fetch(`${API}/${path}?${params}&access_token=${token}`)
  const body = await res.json()
  if (!res.ok || body?.error) {
    throw new Error(`graph ${path}: ${body?.error?.message || res.status}`)
  }
  return body
}

/** Most recent recorded Followers value for a platform, or null if none. */
function lastFollowers(rows: string[][], platform: string): number | null {
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i]?.[1] === platform) {
      const n = Number(rows[i][2])
      return Number.isFinite(n) ? n : null
    }
  }
  return null
}

export async function ingestFourOlivesSocialOnce(): Promise<{ appended: number; skipped: boolean; detail: string }> {
  const cfg = resolveMetaConfig(PROJECT)
  if (!cfg) return { appended: 0, skipped: true, detail: 'no meta config' }

  const engine = new IntegrationEngine(CREDENTIAL_ENCRYPTION_KEY)
  engine.register(googleManifest)
  const client = new GoogleClient(engine, process.env.GOOGLE_CLIENT_ID || '', process.env.GOOGLE_CLIENT_SECRET || '')
  const auth = await client.ensureFreshToken(PROJECT, GOOGLE_ACCOUNT)
  const sheets = new SheetsModule()

  // ponytail: UTC date keeps the dedupe key stable regardless of host TZ. The
  // sheet's historical rows are plain YYYY-MM-DD, so this matches.
  const today = new Date().toISOString().slice(0, 10)

  const existing = await sheets.read(auth, SHEET, 'Daily Overview!A:J')
  if (existing.some((r, i) => i >= 1 && r[0] === today)) {
    return { appended: 0, skipped: true, detail: `Daily Overview already has rows for ${today}` }
  }

  const token = cfg.defaultPageToken

  // Facebook page followers (insights metrics deprecated -> followers only).
  let fbFollowers: number | null = null
  try {
    const fb = await graphGet(cfg.defaultPageId, 'fields=followers_count,fan_count', token)
    fbFollowers = Number(fb.followers_count ?? fb.fan_count ?? 0)
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'fop-social-ingest: FB followers fetch failed')
  }

  // Instagram followers + per-post engagement for posts published today.
  let igFollowers: number | null = null
  let igEngToday = 0
  try {
    const ig = await graphGet(cfg.igUserId, 'fields=followers_count,media_count', token)
    igFollowers = Number(ig.followers_count ?? 0)
    const media = await graphGet(`${cfg.igUserId}/media`, 'fields=like_count,comments_count,timestamp&limit=25', token)
    for (const post of media.data || []) {
      if ((post.timestamp || '').slice(0, 10) === today) {
        igEngToday += (post.like_count || 0) + (post.comments_count || 0)
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'fop-social-ingest: IG fetch failed')
  }

  // Build rows: Date, Platform, Followers, New Followers, Reach, Impressions,
  // Engagement, Engagement Rate %, Clicks, Profile Views. Blank = unavailable.
  const rows: string[][] = []
  if (fbFollowers !== null) {
    const prev = lastFollowers(existing, FB_PLATFORM)
    rows.push([today, FB_PLATFORM, String(fbFollowers), prev === null ? '' : String(fbFollowers - prev), '', '', '', '', '', ''])
  }
  if (igFollowers !== null) {
    const prev = lastFollowers(existing, IG_PLATFORM)
    const rate = igFollowers > 0 ? ((igEngToday / igFollowers) * 100).toFixed(2) : ''
    rows.push([today, IG_PLATFORM, String(igFollowers), prev === null ? '' : String(igFollowers - prev), '', '', String(igEngToday), rate, '', ''])
  }

  if (!rows.length) return { appended: 0, skipped: true, detail: 'no metrics fetched (all sources failed)' }

  await sheets.append(auth, SHEET, 'Daily Overview!A1', rows)
  return { appended: rows.length, skipped: false, detail: `appended ${rows.length} rows for ${today}` }
}

export function startSocialIngestSchedule(): void {
  if (timer) return
  if (process.env.FOP_SOCIAL_INGEST_ENABLED === 'false') {
    logger.info('fop-social-ingest: disabled via FOP_SOCIAL_INGEST_ENABLED=false')
    return
  }
  const run = async () => {
    try {
      const r = await ingestFourOlivesSocialOnce()
      logger.info(r, 'fop-social-ingest: tick')
    } catch (err) {
      // Never throw -- a failed ingest must not affect the bot. Next tick retries.
      logger.warn({ err: (err as Error).message }, 'fop-social-ingest: failed (will retry next tick)')
    }
  }
  setTimeout(() => { void run() }, FIRST_RUN_DELAY_MS)
  timer = setInterval(() => { void run() }, INTERVAL_MS)
  timer.unref?.()
  logger.info('fop-social-ingest: hourly schedule started')
}
