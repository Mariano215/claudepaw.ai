import { logger } from '../logger.js'
import { readEnvFile } from '../env.js'
import { GITHUB_CONFIG } from './config.js'
import type { ScoredRepo, RepoTag } from './types.js'

const env = readEnvFile()
const CURATOR_MODEL = env.NEWSLETTER_BRIEF_MODEL || 'claude-sonnet-4-6'

function getAnthropicKey(): string {
  return process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || ''
}

// ---------------------------------------------------------------------------
// Build the per-candidate prompt line
// ---------------------------------------------------------------------------

function daysAgo(d: Date): number {
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86_400_000))
}

function clean(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

function buildCandidateBlock(repos: ScoredRepo[]): string {
  return repos
    .map((r) => {
      const desc = clean(r.description || (r.topics.join(', ') || ''), 200)
      const lang = r.language ?? 'multi'
      const rel = r.latestReleaseTag && r.latestReleaseAt
        ? ` | rel ${r.latestReleaseTag} ${daysAgo(r.latestReleaseAt)}d ago`
        : ''
      return `- ${r.tag} | ${r.fullName} | ${r.stars}★ | ${lang} | pushed ${daysAgo(r.pushedAt)}d ago${rel}: ${desc}`
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// Anthropic Messages API call (mirrors brief.ts:callAnthropicForBrief)
// ---------------------------------------------------------------------------

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>
  error?: { message: string }
}

interface CuratorPick {
  fullName: string
  tag: RepoTag
  whyItMatters: string
}

async function callAnthropicForPicks(
  candidates: ScoredRepo[],
): Promise<CuratorPick[] | null> {
  const apiKey = getAnthropicKey()
  if (!apiKey) {
    logger.warn('ANTHROPIC_API_KEY not set — falling back to deterministic curator')
    return null
  }

  // Gate bypass protection: same kill-switch honor as brief.ts
  try {
    const { checkKillSwitch } = await import('../cost/kill-switch-client.js')
    const sw = await checkKillSwitch()
    if (sw) {
      logger.warn({ reason: sw.reason }, 'GH curator skipped: kill switch tripped')
      return null
    }
  } catch (err) {
    logger.warn({ err }, 'GH curator kill-switch check failed (fail-closed)')
    return null
  }

  const systemPrompt =
    "You are the editor of The Signal newsletter, GitHub section. " +
    "Test User (CISO, AI/security builder) reads this Mondays and Thursdays. " +
    "Your job: pick 6 repos from a candidate list that are positive, helpful, " +
    "worth looking into or contributing to, and signal thought leadership. " +
    "Bias: prefer rising/early projects (60%) with a few established releases (40%). " +
    "Skip toy demos, abandoned forks, marketing fluff. " +
    "No em dashes. No AI cliches. No filler."

  const userPrompt =
    `Candidates:\n${buildCandidateBlock(candidates)}\n\n` +
    `Return ONLY this JSON:\n` +
    `{ "picks": [ { "fullName": "owner/repo", "tag": "agentic|ai|cyber", ` +
    `"whyItMatters": "<one sentence, max 200 chars, prescriptive, no fluff>" } ] }\n` +
    `Exactly ${GITHUB_CONFIG.maxPicks} picks. No preamble, no fences.`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CURATOR_MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500)
      logger.error({ status: res.status, body }, 'Anthropic curator API error')
      return null
    }
    const data = (await res.json()) as AnthropicResponse
    const text = data.content?.find((p) => p.type === 'text')?.text ?? ''
    if (!text) {
      logger.error('Anthropic curator returned no text')
      return null
    }
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim()
    const parsed = JSON.parse(cleaned) as { picks?: CuratorPick[] }
    if (!parsed.picks || !Array.isArray(parsed.picks) || parsed.picks.length === 0) {
      logger.error({ parsed }, 'Curator JSON missing picks[]')
      return null
    }
    return parsed.picks
  } catch (err) {
    logger.error({ err }, 'Anthropic curator call failed')
    return null
  }
}

// ---------------------------------------------------------------------------
// Deterministic fallback: top-N by score with templated blurb
// ---------------------------------------------------------------------------

function deterministicPicks(candidates: ScoredRepo[]): ScoredRepo[] {
  return [...candidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, GITHUB_CONFIG.maxPicks)
    .map((r) => ({
      ...r,
      whyItMatters: deterministicBlurb(r),
    }))
}

function deterministicBlurb(r: ScoredRepo): string {
  const days = Math.max(1, Math.floor((Date.now() - r.pushedAt.getTime()) / 86_400_000))
  return `${r.stars}+ stars, pushed ${days}d ago. Worth a look.`
}

// ---------------------------------------------------------------------------
// Public: curate the shortlist down to maxPicks with LLM, falling back as needed
// ---------------------------------------------------------------------------

export async function curateRepos(shortlist: ScoredRepo[]): Promise<ScoredRepo[]> {
  if (shortlist.length === 0) {
    logger.info('Empty shortlist — no GH picks for this edition')
    return []
  }

  const llmPicks = await callAnthropicForPicks(shortlist)
  if (!llmPicks) {
    logger.warn('Falling back to deterministic GH curator')
    return deterministicPicks(shortlist)
  }

  // Validate: each pick must reference a fullName in the shortlist
  const byName = new Map(shortlist.map((s) => [s.fullName, s]))
  const validated: ScoredRepo[] = []
  for (const p of llmPicks) {
    const base = byName.get(p.fullName)
    if (!base) {
      logger.warn({ pick: p.fullName }, 'Curator picked unknown repo — dropping')
      continue
    }
    validated.push({
      ...base,
      tag: (p.tag as RepoTag) || base.tag,
      whyItMatters: clean(p.whyItMatters || deterministicBlurb(base), 220),
    })
    if (validated.length >= GITHUB_CONFIG.maxPicks) break
  }

  // Top-up from deterministic order if curator returned fewer than maxPicks
  if (validated.length < GITHUB_CONFIG.maxPicks) {
    const usedNames = new Set(validated.map((v) => v.fullName))
    const fallback = deterministicPicks(shortlist).filter((d) => !usedNames.has(d.fullName))
    for (const f of fallback) {
      validated.push(f)
      if (validated.length >= GITHUB_CONFIG.maxPicks) break
    }
  }

  logger.info(
    { picks: validated.length, model: CURATOR_MODEL },
    'GH picks finalized',
  )
  return validated
}
