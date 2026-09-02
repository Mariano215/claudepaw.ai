// Quiet hours for every outbound message.
//
// ChannelManager.send() is the single exit for unprompted messages (scheduler,
// paws, system alerts). Outside the quiet window messages go out at
// once. Inside it, anything that is not urgent is held in notify_quiet_buffer
// and flushed as one message per chat when the window ends.
//
// Window lives in kv_settings under `notify.quiet_hours` as "START-END" in
// 24h local (America/New_York) hours, e.g. "21-8". Empty or "off" disables.
import { getDb, getKvSetting, setKvSetting } from '../db.js'
import { getTelemetryDb } from '../telemetry-db.js'
import { ALLOWED_CHAT_ID, DASHBOARD_URL } from '../config.js'
import { logger } from '../logger.js'

export const QUIET_KV_KEY = 'notify.quiet_hours'
const DEFAULT_WINDOW = '21-8'
const TZ = process.env.CRON_TZ || 'America/New_York'
/** Messages that must wake the operator regardless of the hour. */
const URGENT_RE = /kill[\s-]?switch|NAV drop|\bhalt(ed)?\b|LIVE mode|go-live gate|approv(e|al)/i

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

export function isQuietNow(now = new Date(), raw: string | null = getKvSetting(QUIET_KV_KEY)): boolean {
  // Unit tests run at any hour; never hold messages there unless a window is given explicitly.
  if (raw === null && process.env.VITEST) return false
  const w = parseWindow(raw)
  if (!w) return false
  const h = localHour(now)
  // Window may wrap midnight (21-8) or not (1-5).
  return w.start > w.end ? h >= w.start || h < w.end : h >= w.start && h < w.end
}

export function isUrgent(text: string): boolean {
  return URGENT_RE.test(text)
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
}

export function holdMessage(channelId: string, chatId: string, text: string): void {
  ensureTable()
  getDb()
    .prepare('INSERT INTO notify_quiet_buffer (channel_id, chat_id, text, created_at) VALUES (?, ?, ?, ?)')
    .run(channelId, chatId, text, Date.now())
}

/**
 * Drain the buffer into one message per (channel, chat). Returns the number of
 * held messages released. `sendNow` must bypass the quiet check.
 */
export async function flushHeld(
  sendNow: (channelId: string, chatId: string, text: string) => Promise<void>,
): Promise<number> {
  ensureTable()
  const db = getDb()
  await sendFailureCount(sendNow)
  const rows = db
    .prepare('SELECT id, channel_id, chat_id, text, created_at FROM notify_quiet_buffer ORDER BY id')
    .all() as Array<{ id: number; channel_id: string; chat_id: string; text: string; created_at: number }>
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
    const body = g
      .map((r) => {
        const txt = r.text.length > 400 ? `${r.text.slice(0, 400)}...` : r.text
        return `${fmt.format(new Date(r.created_at))}: ${txt}`
      })
      .join('\n\n')
    try {
      await sendNow(channel_id, chat_id, `Held during quiet hours (${g.length}):\n\n${body}`)
      db.prepare(`DELETE FROM notify_quiet_buffer WHERE id IN (${g.map(() => '?').join(',')})`).run(...g.map((r) => r.id))
    } catch (err) {
      logger.error({ err, channel_id, chat_id }, 'quiet-hours flush failed, will retry next tick')
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
