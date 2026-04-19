import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, CREDENTIAL_ENCRYPTION_KEY } from './config.js'
import { logger } from './logger.js'
import { IntegrationEngine } from './integrations/engine.js'
import { googleManifest } from './integrations/google/manifest.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SliceQuery {
  statuses?: string[]
  limit?: number
  order_by?: string
  platforms?: string[]
}

export interface AgentSoul {
  id: string
  name: string
  emoji: string
  role: string
  mode: 'always-on' | 'active' | 'on-demand'
  keywords: string[]
  capabilities: string[]
  systemPrompt: string
  context_slice?: Record<string, SliceQuery>
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

const soulCache = new Map<string, AgentSoul>()
let baseContext: string = ''

// ---------------------------------------------------------------------------
// YAML-ish frontmatter parser
// ---------------------------------------------------------------------------

type NestedValue = string | string[] | Record<string, SliceQuery>

interface FrontmatterResult {
  meta: Record<string, NestedValue>
  body: string
}

function indentOf(line: string): number {
  const m = line.match(/^(\s*)/)
  return m ? m[1].length : 0
}

function parseFrontmatter(raw: string): FrontmatterResult | null {
  const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
  const match = raw.match(fmRegex)
  if (!match) return null

  const yamlBlock = match[1]
  const body = match[2].trim()
  const meta: Record<string, NestedValue> = {}

  const lines = yamlBlock.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '') { i++; continue }

    // Top-level key only (no indentation)
    const kvMatch = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (!kvMatch) { i++; continue }

    const key = kvMatch[1]
    const value = kvMatch[2].trim()
    i++

    if (value !== '') {
      meta[key] = value
      continue
    }

    // Empty value: either a list or a nested object. Look at next non-blank line.
    let j = i
    while (j < lines.length && lines[j].trim() === '') j++
    if (j >= lines.length) { meta[key] = []; continue }

    const nextIndent = indentOf(lines[j])
    if (nextIndent === 0) { meta[key] = []; continue }

    // Determine list vs nested object by first content line under this key.
    const firstContent = lines[j].trim()
    if (firstContent.startsWith('- ')) {
      // List: gather items until indentation returns to 0 or a non-list line.
      const items: string[] = []
      while (i < lines.length) {
        const cur = lines[i]
        const curTrim = cur.trim()
        if (curTrim === '') { i++; continue }
        if (indentOf(cur) === 0) break
        if (curTrim.startsWith('- ')) {
          items.push(curTrim.slice(2).trim())
          i++
        } else {
          break
        }
      }
      meta[key] = items
    } else {
      // Nested object: two-level structure (subKey -> SliceQuery).
      const obj: Record<string, SliceQuery> = {}
      let currentSub: string | null = null
      let currentQuery: SliceQuery | null = null

      while (i < lines.length) {
        const cur = lines[i]
        const curTrim = cur.trim()
        if (curTrim === '') { i++; continue }
        const ind = indentOf(cur)
        if (ind === 0) break

        // Sub-key at the first indent level under parent
        const subMatch = cur.match(/^(\s+)(\w[\w-]*):\s*(.*)$/)
        if (subMatch) {
          const subIndent = subMatch[1].length
          const subKey = subMatch[2]
          const subValue = subMatch[3].trim()

          if (subIndent === nextIndent) {
            // New sub-entry (e.g. social_posts, articles)
            currentSub = subKey
            currentQuery = {}
            obj[currentSub] = currentQuery
            // A sub-entry can also carry an inline scalar value, but our schema only has objects here.
            if (subValue !== '') {
              // Unexpected: skip.
            }
            i++
            continue
          }

          // Deeper indent: field of current SliceQuery (statuses, limit, order_by, platforms)
          if (currentQuery !== null) {
            if (subValue === '') {
              // It's a list field (statuses, platforms) described on following lines
              const list: string[] = []
              i++
              while (i < lines.length) {
                const nxt = lines[i]
                const nxtTrim = nxt.trim()
                if (nxtTrim === '') { i++; continue }
                if (indentOf(nxt) <= subIndent) break
                if (nxtTrim.startsWith('- ')) {
                  list.push(nxtTrim.slice(2).trim())
                  i++
                } else {
                  break
                }
              }
              if (subKey === 'statuses') currentQuery.statuses = list
              else if (subKey === 'platforms') currentQuery.platforms = list
              // Unknown list fields ignored.
              continue
            }

            // Scalar field
            if (subKey === 'limit') {
              const n = Number.parseInt(subValue, 10)
              if (!Number.isNaN(n)) currentQuery.limit = n
            } else if (subKey === 'order_by') {
              currentQuery.order_by = subValue
            } else if (subKey === 'statuses') {
              // Comma-separated inline fallback
              currentQuery.statuses = subValue.split(',').map((s) => s.trim()).filter(Boolean)
            } else if (subKey === 'platforms') {
              currentQuery.platforms = subValue.split(',').map((s) => s.trim()).filter(Boolean)
            }
            i++
            continue
          }
        }

        // Fallback: skip line
        i++
      }

      meta[key] = obj
    }
  }

  return { meta, body }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(v: NestedValue | undefined): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.join(', ')
  return ''
}

function asArray(v: NestedValue | undefined): string[] {
  if (v === undefined) return []
  if (Array.isArray(v)) return v
  if (typeof v !== 'string') return []
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function asSliceConfig(v: NestedValue | undefined): Record<string, SliceQuery> | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) return undefined
  return v
}

const VALID_MODES = new Set<AgentSoul['mode']>(['always-on', 'active', 'on-demand'])

function isValidMode(v: string): v is AgentSoul['mode'] {
  return VALID_MODES.has(v as AgentSoul['mode'])
}

// ---------------------------------------------------------------------------
// Base context (CLAUDE.md minus ## Personality section)
// ---------------------------------------------------------------------------

function loadBaseContext(): void {
  const claudePath = join(PROJECT_ROOT, 'CLAUDE.md')
  try {
    const raw = readFileSync(claudePath, 'utf-8')
    // Strip the ## Personality section (from heading to next ## or EOF)
    baseContext = raw.replace(/## Personality\r?\n[\s\S]*?(?=\n## |\n$|$)/, '').trim()
  } catch {
    logger.warn('CLAUDE.md not found at %s -- base context will be empty', claudePath)
    baseContext = ''
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function loadAgentFiles(dir: string): AgentSoul[] {
  if (!existsSync(dir)) return []

  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch (err) {
    logger.error({ err }, 'Failed to read agent directory %s', dir)
    return []
  }

  const results: AgentSoul[] = []
  for (const file of files) {
    const filePath = join(dir, file)
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = parseFrontmatter(raw)
      if (!parsed) {
        logger.warn('Skipping %s -- no valid frontmatter', file)
        continue
      }
      const { meta, body } = parsed
      const id = asString(meta['id'])
      const name = asString(meta['name'])
      const emoji = asString(meta['emoji'])
      const role = asString(meta['role'])
      const modeRaw = asString(meta['mode'])
      if (!id || !name || !emoji || !role || !modeRaw) {
        logger.warn('Skipping %s -- missing required field(s)', file)
        continue
      }
      if (!isValidMode(modeRaw)) {
        logger.warn('Skipping %s -- invalid mode "%s"', file, modeRaw)
        continue
      }
      const sliceConfig = asSliceConfig(meta['context_slice'])
      results.push({
        id,
        name,
        emoji,
        role,
        mode: modeRaw,
        keywords: asArray(meta['keywords']),
        capabilities: asArray(meta['capabilities']),
        systemPrompt: body,
        ...(sliceConfig ? { context_slice: sliceConfig } : {}),
      })
    } catch (err) {
      logger.warn({ err }, 'Failed to parse soul file %s', file)
    }
  }
  return results
}

export function loadAllSouls(projectSlug?: string): Map<string, AgentSoul> {
  const agentsDir = join(PROJECT_ROOT, 'agents')

  // Ensure agents/ dir exists
  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true })
    logger.info('Created agents/ directory at %s', agentsDir)
  }

  // Load base context once
  loadBaseContext()

  // Clear cache for reload
  soulCache.clear()

  // Load base agents
  const baseSouls = loadAgentFiles(agentsDir)
  for (const soul of baseSouls) {
    soulCache.set(soul.id, soul)
    logger.info('Loaded agent: %s %s (%s)', soul.emoji, soul.name, soul.id)
  }

  // Overlay project-specific agents if projectSlug provided
  if (projectSlug) {
    const projectDir = join(PROJECT_ROOT, 'projects', projectSlug, 'agents')
    if (existsSync(projectDir)) {
      const projectSouls = loadAgentFiles(projectDir)
      for (const soul of projectSouls) {
        const isOverride = soulCache.has(soul.id)
        soulCache.set(soul.id, soul)
        if (isOverride) {
          logger.info('Project override agent: %s %s (%s)', soul.emoji, soul.name, soul.id)
        } else {
          logger.info('Project-only agent: %s %s (%s)', soul.emoji, soul.name, soul.id)
        }
      }
    }
  }

  logger.info('Agent loader: %d agent(s) loaded', soulCache.size)
  return soulCache
}

export function getSoulsForProject(projectSlug: string): AgentSoul[] {
  const baseDir = join(PROJECT_ROOT, 'agents')
  const projectDir = join(PROJECT_ROOT, 'projects', projectSlug, 'agents')

  const merged = new Map<string, AgentSoul>()

  const baseFiles = loadAgentFiles(baseDir)
  for (const soul of baseFiles) {
    merged.set(soul.id, soul)
  }

  if (existsSync(projectDir)) {
    const projectFiles = loadAgentFiles(projectDir)
    for (const soul of projectFiles) {
      merged.set(soul.id, soul)
    }
  }

  return [...merged.values()]
}

export function getSoul(agentId: string, projectSlug?: string): AgentSoul | undefined {
  // Check cache first
  const cacheKey = projectSlug ? `${projectSlug}:${agentId}` : agentId
  if (soulCache.has(cacheKey)) return soulCache.get(cacheKey)!

  // Check project-specific agents first
  if (projectSlug) {
    const projectDir = join(PROJECT_ROOT, 'projects', projectSlug, 'agents')
    if (existsSync(projectDir)) {
      const projectSouls = loadAgentFiles(projectDir)
      const match = projectSouls.find((s) => s.id === agentId)
      if (match) {
        soulCache.set(cacheKey, match)
        return match
      }
    }
  }
  // Fall back to cached base agents
  return soulCache.get(agentId)
}

export function getAllSouls(projectSlug?: string): AgentSoul[] {
  if (projectSlug) {
    return getSoulsForProject(projectSlug)
  }
  return [...soulCache.values()]
}

// ---------------------------------------------------------------------------
// Integration context
// ---------------------------------------------------------------------------

let _integrationEngine: IntegrationEngine | null = null

function getIntegrationEngine(): IntegrationEngine {
  if (!_integrationEngine) {
    _integrationEngine = new IntegrationEngine(CREDENTIAL_ENCRYPTION_KEY)
    _integrationEngine.register(googleManifest)
  }
  return _integrationEngine
}

function buildIntegrationContext(soul: AgentSoul, projectId: string): string {
  if (!soul.capabilities?.includes('google-workspace')) return ''

  try {
    const engine = getIntegrationEngine()
    const statuses = engine.getStatus(projectId, 'google')
    if (statuses.length === 0) return ''

    const lines = ['## Available Integrations\n']
    for (const s of statuses) {
      if (s.status !== 'connected') continue
      const scopeLabels = s.scopes.map((scope) => {
        if (scope.includes('gmail')) return 'Gmail'
        if (scope.includes('drive')) return 'Drive'
        if (scope.includes('spreadsheets')) return 'Sheets'
        if (scope.includes('calendar')) return 'Calendar'
        return ''
      }).filter(Boolean)
      lines.push(`Google Workspace (${s.account}):`)
      lines.push(`  Services: ${[...new Set(scopeLabels)].join(', ')}`)
    }
    lines.push('')
    lines.push(`Use: node dist/integrations/cli.js service google <gmail|drive|sheets|calendar> <command> --project ${projectId} [--account email]`)
    return lines.join('\n')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Security context
// ---------------------------------------------------------------------------

let _buildSecurityContext: (() => string) | null = null

/**
 * Lazy-load the security context builder to avoid circular imports.
 * Called once; subsequent calls return the cached function.
 */
async function getSecurityContextBuilder(): Promise<(() => string) | null> {
  if (_buildSecurityContext) return _buildSecurityContext
  try {
    const mod = await import('./security/index.js')
    _buildSecurityContext = mod.buildSecurityContext
    return _buildSecurityContext
  } catch {
    return null
  }
}

// Pre-load on next tick so it's ready for synchronous buildAgentPrompt
setTimeout(() => { getSecurityContextBuilder().catch(() => {}) }, 0)

const ACTION_PLAN_INSTRUCTIONS = `[Action Plan]
You can propose action items for the operator to review. Two ways to do it:

1. End your response with a markdown section like this:

## Action Items
- [ ] Short imperative title (priority, executable, due: 2026-05-01)
- [ ] Another item (high)

Valid attributes inside parentheses: low, medium, high, critical, executable, due: YYYY-MM-DD.
Use "executable" only if you can run the item end to end yourself. Items always
land in proposed state and require human approval before anything runs.

2. Or invoke the CLI directly via Bash for richer control:
   node dist/action-cli.js create --project <id> --title "..." --priority high --agent <your-id> --executable

Always propose, never execute. The operator decides what runs.`

export function buildAgentPrompt(soul: AgentSoul, projectId?: string): string {
  const header = `[Agent: ${soul.emoji} ${soul.name} -- ${soul.role}]`
  const envSection = `[ClaudePaw Environment]\n${baseContext}`
  let prompt = `${header}\n${soul.systemPrompt}\n\n${envSection}\n\n${ACTION_PLAN_INSTRUCTIONS}`

  // Inject live security context for the auditor soul
  if (soul.id === 'auditor' && _buildSecurityContext) {
    try {
      const secCtx = _buildSecurityContext()
      if (secCtx) {
        prompt += `\n\n${secCtx}`
      }
    } catch {
      // Security system may not be initialized yet -- skip silently
    }
  }

  // Inject integration context for agents with google-workspace capability
  if (projectId) {
    const intCtx = buildIntegrationContext(soul, projectId)
    if (intCtx) {
      prompt += `\n\n${intCtx}`
    }
  }

  return prompt
}
