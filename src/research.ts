import { logger } from './logger.js'
import { BOT_API_TOKEN, DASHBOARD_URL } from './config.js'

export interface ResearchFinding {
  topic: string
  source?: string
  source_url?: string
  category?: 'cyber' | 'ai' | 'tools' | 'general'
  score?: number
  competitor?: string
  notes?: string
  pipeline?: 'idea' | 'draft' | 'scheduled' | 'live'
  status?: 'new' | 'reviewing' | 'opportunity' | 'published' | 'archived'
}

const FINDING_REGEX = /<!--\s*FINDING:\s*(\{[\s\S]*?\})\s*-->/g

const VALID_CATEGORIES = new Set(['cyber', 'ai', 'tools', 'general'])
const VALID_PIPELINES = new Set(['idea', 'draft', 'scheduled', 'live'])
const VALID_STATUSES = new Set(['new', 'reviewing', 'opportunity', 'published', 'archived'])

/**
 * Lowercase, replace non-alphanumeric with hyphens, collapse, trim, truncate to 80 chars.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

/**
 * Generate a finding ID from topic + today's date.
 */
export function generateFindingId(topic: string): string {
  const dateStr = new Date().toISOString().slice(0, 10)
  return `${slugify(topic)}-${dateStr}`
}

/**
 * Scan agent output for <!-- FINDING: {...} --> markers and parse them.
 * Returns parsed findings with defaults applied. Never throws.
 */
export function extractFindings(output: string): ResearchFinding[] {
  if (!output) return []

  const findings: ResearchFinding[] = []
  let match: RegExpExecArray | null

  FINDING_REGEX.lastIndex = 0

  while ((match = FINDING_REGEX.exec(output)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (!parsed.topic || typeof parsed.topic !== 'string') continue

      findings.push({
        topic: parsed.topic,
        source: parsed.source ?? '',
        source_url: parsed.source_url ?? undefined,
        category: VALID_CATEGORIES.has(parsed.category) ? parsed.category : 'general',
        score: typeof parsed.score === 'number' ? Math.min(100, Math.max(0, parsed.score)) : 50,
        competitor: parsed.competitor ?? '',
        notes: parsed.notes ?? '',
        pipeline: VALID_PIPELINES.has(parsed.pipeline) ? parsed.pipeline : 'idea',
        status: VALID_STATUSES.has(parsed.status) ? parsed.status : 'new',
      })
    } catch {
      logger.warn({ raw: match[0].slice(0, 200) }, 'Failed to parse FINDING marker')
    }
  }

  return findings
}

/**
 * Extract findings from agent output and POST each to the dashboard research API.
 * Returns the count of successfully logged findings. Never throws.
 */
export async function extractAndLogFindings(
  output: string,
  agentName: string,
  projectId: string,
): Promise<number> {
  const findings = extractFindings(output)
  if (findings.length === 0) return 0

  let logged = 0
  const baseUrl = DASHBOARD_URL.replace(/\/$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // BOT_API_TOKEN falls back to DASHBOARD_API_TOKEN in config.ts
  if (BOT_API_TOKEN) headers['x-dashboard-token'] = BOT_API_TOKEN

  for (const finding of findings) {
    try {
      const body = {
        id: generateFindingId(finding.topic),
        ...finding,
        found_by: agentName,
        project_id: projectId,
      }

      const res = await fetch(`${baseUrl}/api/v1/research`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        logger.warn(
          { status: res.status, topic: finding.topic },
          'Failed to POST research finding',
        )
        continue
      }

      logged++
    } catch (err) {
      logger.warn({ err, topic: finding.topic }, 'Error posting research finding')
    }
  }

  if (logged > 0) {
    logger.info({ count: logged, agent: agentName, project: projectId }, 'Logged research findings')
  }

  return logged
}
