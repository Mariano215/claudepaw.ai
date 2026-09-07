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
  repoTitles?: string[],
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
  if (repoTitles && repoTitles.length > 0) {
    sections.push('### GITHUB')
    for (const line of repoTitles.slice(0, 6)) {
      sections.push(`- ${line}`)
    }
  }
  return sections.join('\n')
}

async function callAnthropicForBrief(
  articlesBlock: string,
  topThemes: TopicId[],
): Promise<{ insight: string; implication: string; heroScene?: string } | null> {
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
    "You are the editor of The Signal, a weekly brief on cybersecurity, AI, and research " +
    "read by business leaders, board members, and managers. Most readers are not technical. " +
    "Write in plain English a smart non-expert understands on the first read. Short sentences. " +
    "One idea per sentence. If you must use a technical term, CVE number, or product name, explain " +
    "in the next few words what it is and why the reader should care, in everyday language. " +
    "Say what happened, who it affects, and what it could cost them. " +
    "No jargon, no acronyms without a plain-word gloss, no filler, no AI cliches, no em dashes."

  const userPrompt =
    `Below are the curated articles for this edition. Dominant themes detected: ${themeLabels}.\n\n` +
    `${articlesBlock}\n\n` +
    `Produce three fields as strict JSON:\n\n` +
    `{\n` +
    `  "insight": "<4-6 short sentences. Tell the one story of the week that a busy executive ` +
    `should know. Explain why it matters to a business, in money, downtime, trust, or legal terms. ` +
    `Refer to specific items from the articles, but describe each in plain words ` +
    `(for example: 'a flaw in JFrog Artifactory, a tool many companies use to store software parts, ` +
    `lets attackers skip the login'). Reading level: a sharp 10th grader. No acronym without a gloss.>",\n` +
    `  "implication": "<3-5 short sentences. Concrete things a leader can ask their team to do or ` +
    `check this week. Phrase each as a question to ask or a decision to make, not as a technical ` +
    `procedure. Example: 'Ask your IT lead whether we use Artifactory and whether it was patched this week.' ` +
    `Avoid generic advice like 'review your policies'.>",\n` +
    `  "heroScene": "<One sentence describing a picture that tells this week's story, for an AI ` +
    `image generator. It must include people or characters doing something concrete (a guard, ` +
    `a courier, a locksmith, a crowd, a robot, an animal as a symbol). Name the setting and the action. ` +
    `Describe things, not words: no text, signs, labels, or logos in the scene.>"\n` +
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
    const parsed = JSON.parse(cleaned) as {
      insight?: string
      implication?: string
      heroScene?: string
    }
    if (!parsed.insight || !parsed.implication) {
      logger.error({ parsed }, 'LLM brief missing insight/implication keys')
      return null
    }
    return {
      insight: parsed.insight.trim(),
      implication: parsed.implication.trim(),
      heroScene: parsed.heroScene?.trim() || undefined,
    }
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
  repoTitles?: string[],
): Promise<ExecutiveBrief> {
  const topThemes = analyzeTopics(articles)
  const articlesBlock = formatArticlesForPrompt(articles, repoTitles)

  const llm = await callAnthropicForBrief(articlesBlock, topThemes)
  if (llm) {
    logger.info({ model: BRIEF_MODEL }, 'Executive brief generated via LLM')
    return { insight: llm.insight, implication: llm.implication, topThemes, heroScene: llm.heroScene }
  }

  logger.warn('Falling back to heuristic brief')
  const heuristic = buildHeuristicBrief(articles, topThemes)
  return { ...heuristic, topThemes }
}
