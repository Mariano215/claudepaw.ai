import { TOPIC_MAP } from './config.js'
import { logger } from '../logger.js'
import { readEnvFile } from '../env.js'
import type { ScoredArticle, CategoryId, TopicId, ExecutiveBrief } from './types.js'

const env = readEnvFile()
const BRIEF_MODEL = env.NEWSLETTER_BRIEF_MODEL || 'claude-sonnet-4-6'

function getAnthropicKey(): string {
  // Read at call time so tests can override via process.env and the bot picks
  // up .env changes after a reload.
  return process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || ''
}

// ---------------------------------------------------------------------------
// Topic analysis -- count keyword hits per topic across all articles
// ---------------------------------------------------------------------------

export function analyzeTopics(
  articles: Record<CategoryId, ScoredArticle[]>,
): TopicId[] {
  const topicScores: Record<TopicId, number> = {
    identity: 0,
    supply_chain: 0,
    model_security: 0,
    data_governance: 0,
    ai_operations: 0,
    quantum_readiness: 0,
  }

  const allArticles = [
    ...articles.cyber,
    ...articles.ai,
    ...articles.research,
  ]

  for (const article of allArticles) {
    const text = `${article.title} ${article.summary}`.toLowerCase()
    for (const [topicId, keywords] of Object.entries(TOPIC_MAP)) {
      for (const keyword of keywords) {
        if (text.includes(keyword)) {
          topicScores[topicId as TopicId] += keyword.includes(' ') ? 2 : 1
        }
      }
    }
  }

  // Sort by score descending, take top 3 non-zero
  const sorted = (Object.entries(topicScores) as [TopicId, number][])
    .filter(([, score]) => score > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([id]) => id)

  if (sorted.length === 0) {
    return ['identity']
  }

  return sorted
}

// ---------------------------------------------------------------------------
// Heuristic fallback brief (used when the LLM call fails)
// ---------------------------------------------------------------------------

const TOPIC_LABELS: Record<TopicId, string> = {
  identity: 'Identity & Access',
  supply_chain: 'Supply Chain Security',
  model_security: 'AI/ML Model Security',
  data_governance: 'Data Governance',
  ai_operations: 'AI Operations',
  quantum_readiness: 'Quantum Readiness',
}

const FALLBACK_IMPLICATIONS: Record<TopicId, string> = {
  identity:
    'Review your IAM controls and ensure MFA is enforced across all critical systems. Zero trust adoption should be a priority.',
  supply_chain:
    'Audit your software supply chain. Ensure SBOM generation is automated and third-party dependencies are monitored.',
  model_security:
    'Evaluate your AI/ML pipeline for prompt injection and data poisoning risks. Red team your LLM deployments.',
  data_governance:
    'Verify data classification policies are current and DLP controls are active across cloud and on-prem environments.',
  ai_operations:
    'Ensure model monitoring and drift detection are in place. Standardize your MLOps pipeline with proper CI/CD.',
  quantum_readiness:
    'Begin inventorying cryptographic dependencies. Prioritize migration planning to post-quantum algorithms (NIST PQC).',
}

function buildHeuristicBrief(
  articles: Record<CategoryId, ScoredArticle[]>,
  topThemes: TopicId[],
): { insight: string; implication: string } {
  const themeLabels = topThemes.map((t) => TOPIC_LABELS[t])
  const cyberCount = articles.cyber.length
  const aiCount = articles.ai.length
  const researchCount = articles.research.length
  const totalCount = cyberCount + aiCount + researchCount

  const allArticles = [...articles.cyber, ...articles.ai, ...articles.research]
  const avgHoursOld =
    allArticles.length > 0
      ? allArticles.reduce(
          (sum, a) => sum + (Date.now() - a.publishedAt.getTime()) / 3_600_000,
          0,
        ) / allArticles.length
      : 0

  const insight =
    `This edition covers ${totalCount} curated articles ` +
    `(${cyberCount} cyber, ${aiCount} AI, ${researchCount} research). ` +
    `Dominant themes: ${themeLabels.join(', ')}. ` +
    `Average article freshness: ${Math.round(avgHoursOld)} hours.`

  const implication = topThemes.map((t) => FALLBACK_IMPLICATIONS[t]).join(' ')
  return { insight, implication }
}

// ---------------------------------------------------------------------------
// LLM-powered brief via Anthropic Messages API
// ---------------------------------------------------------------------------

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>
  error?: { message: string }
}

function formatArticlesForPrompt(
  articles: Record<CategoryId, ScoredArticle[]>,
): string {
  const sections: string[] = []
  for (const cat of ['cyber', 'ai', 'research'] as CategoryId[]) {
    if (articles[cat].length === 0) continue
    sections.push(`### ${cat.toUpperCase()}`)
    for (const a of articles[cat].slice(0, 10)) {
      const summary = (a.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400)
      sections.push(`- ${a.title} (${a.sourceDomain}): ${summary}`)
    }
  }
  return sections.join('\n')
}

async function callAnthropicForBrief(
  articlesBlock: string,
  topThemes: TopicId[],
): Promise<{ insight: string; implication: string } | null> {
  const apiKey = getAnthropicKey()
  if (!apiKey) {
    logger.warn('ANTHROPIC_API_KEY not set -- falling back to heuristic brief')
    return null
  }

  // Gate bypass protection: this path makes a raw Anthropic API call that
  // would otherwise skip the kill switch. Honor the kill switch here so a
  // manual or scheduled newsletter trigger cannot burn tokens while the
  // system is paused.
  try {
    const { checkKillSwitch } = await import('../cost/kill-switch-client.js')
    const sw = await checkKillSwitch()
    if (sw) {
      logger.warn({ reason: sw.reason }, 'newsletter brief skipped: kill switch tripped')
      return null
    }
  } catch (err) {
    logger.warn({ err }, 'newsletter brief kill-switch check failed (fail-closed)')
    return null
  }

  const themeLabels = topThemes.map((t) => TOPIC_LABELS[t]).join(', ')
  const systemPrompt =
    "You are the editor of The Asymmetry, a senior-executive intelligence brief covering " +
    "cybersecurity, AI, and research. Your audience is Test User, a CISO and AI/security " +
    "builder. Write with authority, density, and sharp judgment. No filler. No AI cliches. " +
    "No em dashes. Every sentence must advance the argument."

  const userPrompt =
    `Below are the curated articles for this edition. Dominant themes detected: ${themeLabels}.\n\n` +
    `${articlesBlock}\n\n` +
    `Produce two sections as strict JSON:\n\n` +
    `{\n` +
    `  "insight": "<4-6 sentences. Identify the real story across these items. ` +
    `What connects them? What shift is underway that a busy CISO should notice? ` +
    `Be specific -- reference concrete items, vendors, CVEs, or techniques from the articles. ` +
    `Do not just summarize counts or themes. Draw a non-obvious conclusion.>",\n` +
    `  "implication": "<3-5 sentences of actionable guidance tailored to a CISO running ` +
    `a cybersecurity + AI shop. Name the specific control, process, or tool to change this week. ` +
    `Avoid generic advice like 'review your IAM policies'. Be prescriptive and time-bound.>"\n` +
    `}\n\n` +
    `Return ONLY the JSON object. No preamble, no markdown fences.`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: BRIEF_MODEL,
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      logger.error({ status: res.status, body: body.slice(0, 500) }, 'Anthropic brief API error')
      return null
    }

    const data = (await res.json()) as AnthropicResponse
    const text = data.content?.find((p) => p.type === 'text')?.text ?? ''
    if (!text) {
      logger.error('Anthropic response had no text content')
      return null
    }

    // Strip optional code fences and parse JSON
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    const parsed = JSON.parse(cleaned) as { insight?: string; implication?: string }
    if (!parsed.insight || !parsed.implication) {
      logger.error({ parsed }, 'LLM brief missing insight/implication keys')
      return null
    }
    return { insight: parsed.insight.trim(), implication: parsed.implication.trim() }
  } catch (err) {
    logger.error({ err }, 'Anthropic brief generation failed')
    return null
  }
}

// ---------------------------------------------------------------------------
// Executive brief generation (async: LLM-powered with heuristic fallback)
// ---------------------------------------------------------------------------

export async function generateExecutiveBrief(
  articles: Record<CategoryId, ScoredArticle[]>,
): Promise<ExecutiveBrief> {
  const topThemes = analyzeTopics(articles)
  const articlesBlock = formatArticlesForPrompt(articles)

  const llm = await callAnthropicForBrief(articlesBlock, topThemes)
  if (llm) {
    logger.info({ model: BRIEF_MODEL }, 'Executive brief generated via LLM')
    return { insight: llm.insight, implication: llm.implication, topThemes }
  }

  logger.warn('Falling back to heuristic brief')
  const heuristic = buildHeuristicBrief(articles, topThemes)
  return { ...heuristic, topThemes }
}
