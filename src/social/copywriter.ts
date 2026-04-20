import { logger } from '../logger.js'
import { getServiceCredentials } from '../credentials.js'

export interface YouTubeVideoMeta {
  id: string
  title: string
  description: string
  isShort: boolean
  publishedAt: string
}

export interface CrossPostCopy {
  linkedin: string
  twitter: string
}

// ---------------------------------------------------------------------------
// YouTube Data API: fetch metadata for a single video
// ---------------------------------------------------------------------------

// Returns a fresh access token if OAuth creds are present, null otherwise.
// Throws on token exchange failure (so callers know OAuth is configured but broken).
async function getYouTubeAccessToken(
  creds: Record<string, string>,
): Promise<string | null> {
  const clientId = creds['client_id']
  const clientSecret = creds['client_secret']
  const refreshToken = creds['refresh_token']
  if (!clientId || !clientSecret || !refreshToken) return null
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`YouTube OAuth refresh failed ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

export async function fetchYouTubeVideoMeta(
  videoId: string,
  projectId: string,
): Promise<YouTubeVideoMeta> {
  const creds = getServiceCredentials(projectId, 'youtube')
  // Prefer OAuth (sees private/scheduled videos). Fall back to api_key.
  const accessToken = await getYouTubeAccessToken(creds)
  const authMode = accessToken ? 'oauth' : 'apiKey'
  const headers: Record<string, string> = {}
  let url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}`
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`
  } else {
    const apiKey = creds['api_key']
    if (!apiKey) {
      throw new Error(`No YouTube api_key or OAuth refresh_token for project ${projectId}`)
    }
    url += `&key=${apiKey}`
  }
  logger.debug({ videoId, projectId, authMode }, 'fetchYouTubeVideoMeta')
  const res = await fetch(url, { headers })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`YouTube videos.list ${res.status} (auth=${authMode}): ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    items?: Array<{
      snippet: { title: string; description: string; publishedAt: string }
      contentDetails: { duration: string }
    }>
  }
  const item = data.items?.[0]
  if (!item) {
    throw new Error(`YouTube video ${videoId} not found or not visible to API key`)
  }
  const durationSec = iso8601ToSeconds(item.contentDetails.duration)
  return {
    id: videoId,
    title: item.snippet.title,
    description: item.snippet.description,
    isShort: durationSec <= 62,
    publishedAt: item.snippet.publishedAt,
  }
}

function iso8601ToSeconds(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return 0
  return (
    parseInt(m[1] ?? '0') * 3600 +
    parseInt(m[2] ?? '0') * 60 +
    parseInt(m[3] ?? '0')
  )
}

// ---------------------------------------------------------------------------
// Prompt builder + response parser (pure functions, unit-tested)
// ---------------------------------------------------------------------------

export function buildCopyPrompt(meta: YouTubeVideoMeta): string {
  const typeLabel = meta.isShort ? 'short (60s vertical clip)' : 'video (long-form horizontal)'
  const descTrunc = (meta.description ?? '').slice(0, 500)
  return `You are generating cross-post copy for a YouTube release.

Video title: ${meta.title}
YouTube URL: https://youtu.be/${meta.id}
Type: ${typeLabel}
Description (first 500 chars): ${descTrunc}

Write two posts. Return ONLY valid JSON in this exact shape:

{
  "linkedin": "<200 to 400 chars, narrative hook, ends with the YouTube URL on its own line, no hashtags>",
  "twitter": "<under 260 chars including the URL, punchy opener, URL on its own line, 1 or 2 hashtags max>"
}

Voice rules (hard):
- No em dashes. Ever.
- No AI cliches: never say "Certainly", "Great question", "I'd be happy to", "As an AI".
- No sycophancy. No hedging.
- Plain declaratives. Active voice.

Content rules:
- LinkedIn: lead with the concrete problem or insight. One paragraph of narrative, then the link. Readable by a CISO peer.
- X: hook in first line. Optional 1-2 short lines. URL on its own line. Hashtags last.
- Both: do not describe the video. Describe what the viewer learns or gains.`
}

export function parseCopyResponse(raw: string): CrossPostCopy {
  // Strip optional ```json fences
  let body = raw.trim()
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) body = fenced[1].trim()
  // Find the first { ... } JSON object
  const jsonStart = body.indexOf('{')
  const jsonEnd = body.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    throw new Error(`No JSON object in copy response: ${body.slice(0, 200)}`)
  }
  const obj = JSON.parse(body.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>
  if (typeof obj.linkedin !== 'string' || obj.linkedin.length === 0) {
    throw new Error('Copy response missing "linkedin" string')
  }
  if (typeof obj.twitter !== 'string' || obj.twitter.length === 0) {
    throw new Error('Copy response missing "twitter" string')
  }
  return { linkedin: obj.linkedin, twitter: obj.twitter }
}

// ---------------------------------------------------------------------------
// Producer-driven copy generation (integration glue; not unit-tested here --
// tested manually in the end-to-end step)
// ---------------------------------------------------------------------------

export async function generateCrossPostCopy(
  meta: YouTubeVideoMeta,
  projectId: string,
): Promise<CrossPostCopy> {
  const prompt = buildCopyPrompt(meta)

  // Lazy import to match the pattern used elsewhere in the codebase
  // (avoids circular deps between scheduler + agent modules).
  const { runAgent } = await import('../agent.js')
  const { getSoul, buildAgentPrompt } = await import('../souls.js')

  // Project-aware soul lookup: default has its own 'producer' agent.
  const soul = getSoul('producer', projectId)
  const systemPrompt = soul ? buildAgentPrompt(soul, projectId) : ''
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt

  const res = await runAgent(
    fullPrompt,
    undefined, // sessionId
    undefined, // onTyping
    true,      // guardHarden
    undefined, // onEvent
    { projectId, source: 'social-copywriter' },
    { projectId, agentId: 'producer' },
  )

  if (!res.text) {
    logger.warn({ meta: meta.id }, 'Producer returned no text')
    throw new Error(`Producer returned no text for video ${meta.id}: ${res.emptyReason ?? 'unknown'}`)
  }
  return parseCopyResponse(res.text)
}
