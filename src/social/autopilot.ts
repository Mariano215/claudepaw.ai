/**
 * Social autopilot: every Sunday evening (ET), draft next week's posts for each
 * project with the `social_autopilot` knob on, and send Telegram cards with
 * Queue / Reject. Queue marks the drafts approved with scheduled_at set, and
 * the existing publishDueSocialPosts() tick posts them on time.
 *
 * Data is gathered here in trusted code (project context, recent WordPress
 * posts, recent social posts). The agent only writes text, so this works
 * under the SDK Bash allowlist that blocks curl, sqlite3 and sheets-cli.
 */
import { logger } from '../logger.js'
import { createDraft, getPost, markApprovedScheduled } from './db.js'
import { isPlatformConfigured } from './index.js'
import type { Platform, SocialPost } from './types.js'
import type { PawSender } from '../paws/types.js'

const TZ = 'America/New_York'
const POST_HOUR_ET = 10
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const TEXT_PLATFORMS: Platform[] = ['linkedin', 'facebook', 'instagram', 'twitter']

export interface WpItem { title: string; link: string; excerpt: string; image: string | null }
export interface PlannedPost { day: string; long: string; short: string; link: string | null }
type Keyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

function etParts(ms: number): { y: number; m: number; d: number; h: number; wd: string } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23', weekday: 'short',
  })
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, wd: p.weekday }
}

/** UTC ms for a wall-clock hour in ET on the given calendar date (DST-safe). */
export function etToUtc(y: number, m: number, d: number, h: number): number {
  const guess = Date.UTC(y, m - 1, d, h)
  const seen = etParts(guess)
  const seenMs = Date.UTC(seen.y, seen.m - 1, seen.d, seen.h)
  return guess + (guess - seenMs)
}

/** Scheduled time for a planned weekday in the week after `nowMs` (a Sunday). */
export function slotFor(day: string, nowMs: number): number {
  const idx = Math.max(0, DAYS.indexOf(day as typeof DAYS[number]))
  const t = etParts(nowMs)
  // Next Monday = tomorrow when run on Sunday. Date.UTC normalizes day overflow.
  const base = new Date(Date.UTC(t.y, t.m - 1, t.d + 1 + idx))
  return etToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), POST_HOUR_ET)
}

/** Sunday at or after 17:00 ET, and not already run this week. */
export function isDue(nowMs: number, lastRunMs: number | null): boolean {
  const t = etParts(nowMs)
  if (t.wd !== 'Sun' || t.h < 17) return false
  return !lastRunMs || nowMs - lastRunMs > 3 * 24 * 60 * 60 * 1000
}

export function buildPlanPrompt(opts: {
  projectName: string
  context: string
  count: number
  wp: WpItem[]
  recent: string[]
  wantShort: boolean
}): string {
  const wp = opts.wp.length
    ? opts.wp.map((w) => `- ${w.title} | ${w.link} | ${w.excerpt.slice(0, 200)}`).join('\n')
    : '(none)'
  const recent = opts.recent.length ? opts.recent.map((r) => `- ${r.slice(0, 160)}`).join('\n') : '(none)'
  return `Plan next week's social posts for ${opts.projectName}.

${opts.context || '(no project context file)'}

Recent website posts you may promote or resurface (title | link | excerpt):
${wp}

Recently posted (do not repeat these angles):
${recent}

Write ${opts.count} posts spread across Mon to Fri. Mix: one can promote a website post,
the rest are evergreen (behind the scenes, a lesson learned, a question to the audience,
a milestone). Never invent facts, dates, awards, festival selections or numbers that are
not in the context above.

Return ONLY valid JSON:
{"posts":[{"day":"Mon|Tue|Wed|Thu|Fri","long":"<post for LinkedIn/Facebook/Instagram, 300 to 900 chars>",${opts.wantShort ? '"short":"<under 260 chars for X>",' : ''}"link":"<one website link from the list above if this post promotes it, else null>"}]}

Voice: plain, human, specific. No em dashes. No hashtag walls (0 to 3). No "excited to announce".`
}

export function parsePlan(raw: string, count: number): PlannedPost[] {
  const body = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  const obj = JSON.parse(body) as { posts?: Array<Record<string, unknown>> }
  return (obj.posts ?? [])
    .filter((p) => typeof p.long === 'string' && p.long.trim())
    .slice(0, count)
    .map((p) => ({
      day: typeof p.day === 'string' ? p.day.slice(0, 3) : 'Mon',
      long: String(p.long).trim(),
      short: typeof p.short === 'string' && p.short.trim() ? String(p.short).trim().slice(0, 280) : String(p.long).slice(0, 270),
      link: typeof p.link === 'string' && p.link.startsWith('http') ? p.link : null,
    }))
}

export function buildPlanCard(projectName: string, posts: SocialPost[]): { text: string; keyboard: Keyboard } {
  const first = posts[0]!
  const when = first.suggested_time
    ? new Date(first.suggested_time).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' })
    : 'unscheduled'
  const platforms = posts.map((p) => p.platform).join(', ')
  const ids = posts.map((p) => p.id).join(',')
  return {
    text: `Planned post (${projectName})\nWhen: ${when} ET\nWhere: ${platforms}\n\n${first.content}`,
    keyboard: { inline_keyboard: [[
      { text: 'Queue', callback_data: `social:queue:${ids}` },
      { text: 'Reject', callback_data: `social:rejectg:${ids}` },
    ]] },
  }
}

// ---------------------------------------------------------------------------
// Queue (Telegram callback)
// ---------------------------------------------------------------------------

/** Approve drafts at their planned time (or 5 min from now if that passed). */
export function queueDrafts(ids: string[], nowMs = Date.now()): number {
  let n = 0
  for (const id of ids) {
    const post = getPost(id)
    if (!post || post.status !== 'draft') continue
    const planned = post.suggested_time ? Date.parse(post.suggested_time) : NaN
    const at = Number.isFinite(planned) && planned > nowMs ? planned : nowMs + 5 * 60 * 1000
    if (markApprovedScheduled(id, at)) n += 1
  }
  return n
}

// ---------------------------------------------------------------------------
// Weekly run (scheduler tick)
// ---------------------------------------------------------------------------

async function fetchWp(siteUrl: string): Promise<WpItem[]> {
  const res = await fetch(`${siteUrl.replace(/\/$/, '')}/wp-json/wp/v2/posts?per_page=8&_embed=wp:featuredmedia`, {
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`wp ${res.status}`)
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&#?\w+;/g, ' ').trim()
  return ((await res.json()) as any[]).map((p) => ({
    title: strip(p.title?.rendered ?? ''),
    link: p.link,
    excerpt: strip(p.excerpt?.rendered ?? ''),
    image: p._embedded?.['wp:featuredmedia']?.[0]?.source_url ?? null,
  }))
}

export async function runSocialAutopilot(send: PawSender, chatId: string, nowMs = Date.now()): Promise<number> {
  const { listProjects, getKnob, getKvSetting, setKvSetting } = await import('../db.js')
  const KEY = 'social_autopilot_last_run'
  if (!isDue(nowMs, Number(getKvSetting(KEY) ?? 0) || null)) return 0
  // Marked before the work so a failure waits for next week instead of retrying every tick.
  setKvSetting(KEY, String(nowMs))

  const { loadHotContext } = await import('../pipeline.js')
  const { runAgent } = await import('../agent.js')
  const { getSoul, buildAgentPrompt } = await import('../souls.js')
  const { listPosts } = await import('./db.js')
  let cards = 0

  for (const project of listProjects()) {
    const pid = project.id
    if (getKnob<string>(pid, 'social_autopilot', 'off') !== 'on') continue
    const name = project.display_name ?? pid
    try {
      const wanted = getKnob<string>(pid, 'social_platforms', '')
        .split(',').map((s) => s.trim()).filter(Boolean) as Platform[]
      const platforms = (wanted.length ? wanted : TEXT_PLATFORMS)
        .filter((p) => TEXT_PLATFORMS.includes(p) && isPlatformConfigured(pid, p))
      if (!platforms.length) {
        await send(chatId, `Social autopilot (${name}): no configured platforms, skipped. Fix credentials or the social_platforms knob.`, undefined, pid)
        continue
      }
      const count = Math.min(7, Math.max(1, getKnob<number>(pid, 'social_posts_per_week', 3)))
      const wpUrl = getKnob<string>(pid, 'social_wp_url', '')
      const wp = wpUrl ? await fetchWp(wpUrl).catch((err) => { logger.warn({ err, pid }, 'autopilot: wp fetch failed'); return [] }) : []
      const recent = listPosts(undefined, 200).filter((p) => p.project_id === pid && p.status === 'published').slice(0, 15).map((p) => p.content)

      const prompt = buildPlanPrompt({
        projectName: name, context: loadHotContext(project.slug ?? pid), count, wp, recent,
        wantShort: platforms.includes('twitter'),
      })
      const soul = getSoul('social-manager', pid) ?? getSoul('social-writer', pid) ?? getSoul('content-creator', pid)
      const full = soul ? `${buildAgentPrompt(soul, pid)}\n\n---\n\n${prompt}` : prompt
      const res = await runAgent(full, undefined, undefined, true, undefined,
        { projectId: pid, source: 'social-autopilot' }, { projectId: pid, agentId: soul?.id ?? 'social-autopilot' })
      if (!res.text) throw new Error(`agent returned no text: ${res.emptyReason ?? 'unknown'}`)

      for (const plan of parsePlan(res.text, count)) {
        const image = plan.link ? wp.find((w) => w.link === plan.link)?.image ?? null : null
        const when = new Date(slotFor(plan.day, nowMs)).toISOString()
        const text = plan.link && !plan.long.includes(plan.link) ? `${plan.long}\n\n${plan.link}` : plan.long
        const drafts: SocialPost[] = []
        for (const platform of platforms) {
          if (platform === 'instagram' && !image) continue // IG needs an image
          drafts.push(createDraft({
            platform, project_id: pid, created_by: 'social-autopilot', suggested_time: when,
            content: platform === 'twitter' ? plan.short : text,
            media_url: platform === 'instagram' || (platform === 'facebook' && image) ? image ?? undefined : undefined,
          }))
        }
        if (!drafts.length) continue
        const card = buildPlanCard(name, drafts)
        await send(chatId, card.text, card.keyboard, pid)
        cards += 1
      }
    } catch (err) {
      logger.error({ err, pid }, 'social-autopilot: project failed')
      await send(chatId, `Social autopilot (${name}) failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`, undefined, pid).catch(() => {})
    }
  }
  if (cards) logger.info({ cards }, 'social-autopilot: plan cards sent')
  return cards
}
