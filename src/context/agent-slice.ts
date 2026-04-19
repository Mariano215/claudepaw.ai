import { getDb } from '../db.js'
import { type Budget, estimateTokens } from './budget.js'
import { logger } from '../logger.js'

export interface SliceQuery {
  statuses?: string[]
  limit?: number
  order_by?: string
  platforms?: string[]
}

export type AgentSliceConfig = Record<string, SliceQuery>

type SliceRunner = (q: SliceQuery, projectId: string) => string

const RUNNERS: Record<string, SliceRunner> = {
  social_posts: (q, projectId) => {
    const statuses = q.statuses ?? ['draft', 'approved']
    const limit = q.limit ?? 10
    try {
      const rows = getDb()
        .prepare(`
          SELECT platform, status, content FROM social_posts
          WHERE project_id = ? AND status IN (${statuses.map(() => '?').join(',')})
          ORDER BY created_at DESC LIMIT ?
        `)
        .all(projectId, ...statuses, limit) as Array<{ platform: string; status: string; content: string }>
      if (rows.length === 0) return ''
      const lines = [`[Social posts: ${rows.length}]`]
      for (const r of rows) {
        lines.push(`  - (${r.platform}, ${r.status}) ${r.content.slice(0, 80).replace(/\n/g, ' ')}`)
      }
      return lines.join('\n')
    } catch {
      return ''
    }
  },
  articles: (q, projectId) => {
    const statuses = q.statuses ?? ['outlining', 'drafting', 'approved']
    const limit = q.limit ?? 10
    try {
      const rows = getDb()
        .prepare(`
          SELECT title, status FROM action_items
          WHERE project_id = ? AND status IN (${statuses.map(() => '?').join(',')}) AND title LIKE 'article:%'
          ORDER BY updated_at DESC LIMIT ?
        `)
        .all(projectId, ...statuses, limit) as Array<{ title: string; status: string }>
      if (rows.length === 0) return ''
      const lines = [`[Articles: ${rows.length}]`]
      for (const r of rows) lines.push(`  - (${r.status}) ${r.title.replace(/^article:\s*/, '')}`)
      return lines.join('\n')
    } catch {
      return ''
    }
  },
  security_findings: (q, projectId) => {
    const limit = q.limit ?? 10
    try {
      const rows = getDb()
        .prepare(`
          SELECT title, severity, status FROM security_findings
          WHERE project_id = ? AND status = 'open'
          ORDER BY CASE severity
            WHEN 'critical' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            ELSE 3
          END
          LIMIT ?
        `)
        .all(projectId, limit) as Array<{ title: string; severity: string; status: string }>
      if (rows.length === 0) return ''
      const lines = [`[Security findings: ${rows.length}]`]
      for (const r of rows) lines.push(`  - (${r.severity}, ${r.status}) ${r.title}`)
      return lines.join('\n')
    } catch {
      return ''
    }
  },
  research_findings: (q, projectId) => {
    const limit = q.limit ?? 10
    try {
      const rows = getDb()
        .prepare(`
          SELECT title, status FROM action_items
          WHERE project_id = ? AND title LIKE 'research:%' AND status != 'archived'
          ORDER BY updated_at DESC LIMIT ?
        `)
        .all(projectId, limit) as Array<{ title: string; status: string }>
      if (rows.length === 0) return ''
      const lines = [`[Research findings: ${rows.length}]`]
      for (const r of rows) lines.push(`  - (${r.status}) ${r.title.replace(/^research:\s*/, '')}`)
      return lines.join('\n')
    } catch {
      return ''
    }
  },
  recent_commits: () => '',
}

export async function buildAgentSlice(
  config: AgentSliceConfig | null,
  projectId: string,
  budget: Budget,
): Promise<string> {
  if (!config) return ''
  const parts: string[] = []
  for (const [key, query] of Object.entries(config)) {
    const runner = RUNNERS[key]
    if (!runner) {
      logger.debug({ key }, 'unknown slice key')
      continue
    }
    try {
      const block = runner(query, projectId)
      if (!block) continue
      if (estimateTokens(block) > budget.remaining) break
      parts.push(block)
      budget.consumeText(block)
    } catch (err) {
      logger.debug({ err, key }, 'runner failed')
    }
  }
  return parts.join('\n\n')
}
