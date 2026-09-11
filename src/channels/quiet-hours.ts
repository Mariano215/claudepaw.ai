// Quiet hours for every outbound message.
//
// ChannelManager.send() is the single exit for unprompted messages (scheduler,
// paws, system alerts). Outside the quiet window messages go out at
// once. Inside it, anything that is not urgent is held in notify_quiet_buffer
// and flushed as one message per chat when the window ends.
//
// Window is the `quiet_hours` knob on the default project (dashboard Settings
// page) as "START-END" in 24h local (America/New_York) hours, e.g. "21-8".
// "off" disables.
import { getDb, getKnob, getKvSetting, setKvSetting } from '../db.js'
import { getTelemetryDb } from '../telemetry-db.js'
import { ALLOWED_CHAT_ID, DASHBOARD_URL } from '../config.js'
import { logger } from '../logger.js'

const DEFAULT_WINDOW = '21-8'
const TZ = process.env.CRON_TZ || 'America/New_York'
/**
 * Messages that must wake the operator regardless of the hour. This absorbed
 * the trader ISSUE_RE terms so one regex decides urgency for the whole app
 * (spec 5.1). Anything not matched here is routine and goes to the digest.
 *
 * Only trader-specific spellings are here. `could not`, `unreachable`,
 * `did not start` and a bare `ALERT` were app-wide before, and a routine paw
 * report saying "could not find a new listing" woke the operator at 3am,
 * which is the exact noise the digest buffer exists to remove.
 *
 * `needs you` is the owner-attention marker across the app, so it is urgent on
 * its own. That covers the alerts that say what happened in plain English and
 * never use a failure keyword, such as the engine-outage line "Trader (needs
 * you): the trading service stopped responding". "Handled without you" does
 * not contain the phrase, so the routine digest is unaffected.
 *
 * The generic words survive behind a TRADER prefix, anchored to the start of a
 * line. ChannelManager.send, not isTraderIssue, is the last gate before a
 * message is held, so scoping them into the trader classifier alone would have
 * buffered a real engine failure until the next 08:00 drain. The anchor keeps
 * prose that mentions a trader mid-sentence routine, which an unanchored
 * alternation let back in.
 */
const URGENT_RE = /needs you|kill[\s-]?switch|NAV drop|\bhalt(ed)?\b|LIVE mode|go-live gate|approv(e|al)|TRADER ALERT|engine submit rejected|(^|\n)TRADER[^\n]{0,40}\b(unreachable|could not|did not start|ALERT)\b/i

function localHour(now: Date): number {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(now)
  return parseInt(s, 10) % 24
}

export function parseWindow(raw: string | null): { start: number; end: number } | null {
  const v = (raw ?? DEFAULT_WINDOW).trim().toLowerCase()
  if (!v || v === 'off') return null
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(v)
  if (!m) return null
  const start = parseInt(m[1], 10)
  const end = parseInt(m[2], 10)
  if (start > 23 || end > 23 || start === end) return null
  return { start, end }
}

// Unit tests run at any hour; never hold messages there unless a window is given explicitly.
const configuredWindow = (): string => (process.env.VITEST ? 'off' : getKnob('default', 'quiet_hours', DEFAULT_WINDOW))

export function isQuietNow(now = new Date(), raw: string | null = configuredWindow()): boolean {
  const w = parseWindow(raw)
  if (!w) return false
  const h = localHour(now)
  // Window may wrap midnight (21-8) or not (1-5).
  return w.start > w.end ? h >= w.start || h < w.end : h >= w.start && h < w.end
}

export function isUrgent(text: string): boolean {
  return URGENT_RE.test(text)
}

export type DigestMode = 'daily' | 'off'

/**
 * daily: every routine message is held and released in the 08:00 digest.
 * off:   pre-v2 behavior, routine messages are held only during quiet hours.
 */
export function digestMode(): DigestMode {
  return getKnob<string>('default', 'digest_mode', 'daily') === 'off' ? 'off' : 'daily'
}

/** The single hold decision for ChannelManager.send(). */
export function shouldHold(text: string, now = new Date()): boolean {
  if (isUrgent(text)) return false
  if (digestMode() === 'daily') return true
  // Read the knob directly rather than through isQuietNow()'s default, which
  // forces 'off' under VITEST so unrelated tests don't need a real window.
  return isQuietNow(now, getKnob('default', 'quiet_hours', DEFAULT_WINDOW))
}

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS notify_quiet_buffer (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      chat_id    TEXT NOT NULL,
      text       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  // The table predates the digest, so the column is added in place. Existing
  // rows keep a null project and drain under "other".
  try {
    getDb().exec('ALTER TABLE notify_quiet_buffer ADD COLUMN project_id TEXT')
  } catch { /* column already exists */ }
}

export function holdMessage(channelId: string, chatId: string, text: string, projectId?: string): void {
  ensureTable()
  getDb()
    .prepare('INSERT INTO notify_quiet_buffer (channel_id, chat_id, text, created_at, project_id) VALUES (?, ?, ?, ?, ?)')
    .run(channelId, chatId, text, Date.now(), projectId ?? null)
}

/** kv_settings key for the last daily-digest drain, read by the scheduler's 08:00 tick. */
export const LAST_DRAIN_KEY = 'notify.last_drain_ms'
/** Local hour the daily digest drains the routine buffer. Matches the 08:05 email job. */
const DRAIN_HOUR = 8

/** kv_settings key for the last drain attempt, successful or not. */
export const LAST_DRAIN_ATTEMPT_KEY = 'notify.last_drain_attempt_ms'

// The drain window runs from 08:00 to the end of the local day and the
// scheduler ticks every 60s, so without a floor a sustained send outage would
// rebuild the report on every tick for the rest of the day.
const DRAIN_RETRY_MS = 10 * 60 * 1000

function localDateKey(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms))
}

/**
 * Fire once a day, from DRAIN_HOUR local onwards. The gate used to be the
 * 08:00 hour exactly, so a bot that was down or restarting across that hour
 * skipped the whole day's digest and left the buffer growing until the next
 * morning. Pure, so it is unit-tested directly; the caller persists
 * lastDrainMs via kv_settings.
 */
export function shouldDrainNow(
  nowMs: number,
  lastDrainMs: number | null,
  lastAttemptMs: number | null = null,
): boolean {
  if (localHour(new Date(nowMs)) < DRAIN_HOUR) return false
  if (lastDrainMs != null && localDateKey(lastDrainMs) === localDateKey(nowMs)) return false
  if (lastAttemptMs != null && nowMs - lastAttemptMs < DRAIN_RETRY_MS) return false
  return true
}

// The 12h nudge for a parked routine lives in renderDigestText's Needs you
// section, which the scheduler sends immediately before this drain. It used to
// be rendered here as well, so the 08:00 message named the same parked routine
// twice.

/**
 * Drain the buffer into one message per (channel, chat), grouped by project
 * inside as "Handled without you" (spec 5.2). Returns the number of held
 * messages released. `sendNow` must bypass the quiet check.
 */
export async function flushHeld(
  sendNow: (channelId: string, chatId: string, text: string) => Promise<void>,
): Promise<number> {
  ensureTable()
  const db = getDb()
  await sendFailureCount(sendNow)
  const rows = db
    .prepare('SELECT id, channel_id, chat_id, text, created_at, project_id FROM notify_quiet_buffer ORDER BY id')
    .all() as Array<{ id: number; channel_id: string; chat_id: string; text: string; created_at: number; project_id: string | null }>
  if (rows.length === 0) return 0

  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const k = `${r.channel_id} ${r.chat_id}`
    const g = groups.get(k) ?? []
    g.push(r)
    groups.set(k, g)
  }

  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
  for (const [, g] of groups) {
    const { channel_id, chat_id } = g[0]
    const byProject = new Map<string, typeof g>()
    for (const r of g) {
      const key = r.project_id ?? 'other'
      const bucket = byProject.get(key) ?? []
      bucket.push(r)
      byProject.set(key, bucket)
    }
    const sections: string[] = []
    for (const [project, projectRows] of byProject) {
      sections.push(`${project} (${projectRows.length}):`)
      for (const r of projectRows) {
        const txt = r.text.length > 400 ? `${r.text.slice(0, 400)}...` : r.text
        sections.push(`  ${fmt.format(new Date(r.created_at))}: ${txt}`)
      }
      sections.push('')
    }
    const body = ['Handled without you', '', ...sections].filter(Boolean).join('\n')
    try {
      await sendNow(channel_id, chat_id, body)
      db.prepare(`DELETE FROM notify_quiet_buffer WHERE id IN (${g.map(() => '?').join(',')})`).run(...g.map((r) => r.id))
    } catch (err) {
      logger.error({ err, channel_id, chat_id }, 'digest drain failed, will retry next tick')
    }
  }
  return rows.length
}

const LAST_FLUSH_KEY = 'notify.last_flush_ms'

/**
 * Once per flush window, tell the operator how many failures landed in
 * error_log since the last flush. Details live on the dashboard Inbox page;
 * Telegram only carries the count.
 */
async function sendFailureCount(
  sendNow: (channelId: string, chatId: string, text: string) => Promise<void>,
): Promise<void> {
  const last = Number(getKvSetting(LAST_FLUSH_KEY) ?? 0)
  const now = Date.now()
  // The flush timer ticks every minute; only count once the window has ended,
  // which is at least 6h after the previous count.
  if (now - last < 6 * 60 * 60 * 1000) return
  setKvSetting(LAST_FLUSH_KEY, String(now))
  if (!ALLOWED_CHAT_ID) return
  let n = 0
  try {
    const row = getTelemetryDb()
      .prepare("SELECT COUNT(*) AS n FROM error_log WHERE recorded_at > ? AND severity IN ('warn','error','fatal')")
      .get(last) as { n: number }
    n = row?.n ?? 0
  } catch (err) {
    logger.warn({ err }, 'failure count query failed')
    return
  }
  if (n === 0) return
  const link = DASHBOARD_URL ? ` Inbox: ${DASHBOARD_URL.replace(/\/$/, '')}/#usage` : ''
  try {
    await sendNow('telegram', String(ALLOWED_CHAT_ID), `Since last check: ${n} failure${n === 1 ? '' : 's'} logged.${link}`)
  } catch (err) {
    logger.warn({ err }, 'failure count send failed')
  }
}
