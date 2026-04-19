import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile as execFileCb, spawn } from 'node:child_process'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { CLAUDE_CWD, PROJECT_ROOT } from './config.js'
import { loadProjectMcpServers } from './mcp-loader.js'
import { readEnvFile } from './env.js'
import { getProject, getProjectSettings } from './db.js'
import { getCredential } from './credentials.js'
import { logger } from './logger.js'

export type ExecutionProvider = 'claude_desktop' | 'codex_local' | 'anthropic_api' | 'openai_api' | 'openrouter_api' | 'ollama' | 'lm_studio'
export type FallbackPolicy = 'disabled' | 'enabled'
export type ModelTier = 'cheap' | 'balanced' | 'premium'

export interface AgentRuntimeContext {
  projectId?: string
  projectSlug?: string
  agentId?: string
  executionOverride?: Partial<Pick<ResolvedExecutionSettings, 'provider' | 'secondaryProvider' | 'fallbackProvider' | 'model' | 'modelPrimary' | 'modelSecondary' | 'modelFallback' | 'modelTier' | 'timeoutMs'>> & {
    fallbackPolicy?: FallbackPolicy | 'manual_only' | 'auto_on_quota' | 'auto_on_error'
  }
}

export interface ResolvedExecutionSettings {
  provider: ExecutionProvider
  secondaryProvider: ExecutionProvider | null
  model: string | null
  modelPrimary: string | null
  modelSecondary: string | null
  modelFallback: string | null
  fallbackPolicy: FallbackPolicy
  modelTier: ModelTier
  fallbackProvider: ExecutionProvider | null
  projectId?: string
  projectSlug?: string
  agentId?: string
  timeoutMs?: number
}

export interface AgentToolRestrictions {
  /**
   * When true, a system-prompt prefix is injected that instructs the agent to
   * avoid destructive operations (arbitrary shell commands, filesystem writes
   * outside of read-only tasks, etc.).  Does NOT block tool calls at the SDK
   * level -- it is a defence-in-depth measure on top of Guard.
   */
  restrictedMode?: boolean
  /**
   * Explicit list of tool names the agent is allowed to use.  When non-empty,
   * the injected prefix lists these tools and asks the agent to use only them.
   * Ignored when restrictedMode is false or omitted.
   */
  allowedTools?: string[]
  /**
   * Explicit list of tool names the agent must not use.  When non-empty,
   * the injected prefix lists these tools and instructs the agent to refuse them.
   * Ignored when restrictedMode is false or omitted.
   */
  disallowedTools?: string[]
}

export interface AdapterRunInput {
  prompt: string
  sessionId?: string
  onEvent?: (event: SDKMessage | Record<string, unknown>) => void
  /** Optional tool-use restrictions applied via system-prompt prefix. */
  toolRestrictions?: AgentToolRestrictions
}

export interface AdapterRunResult {
  text: string | null
  newSessionId?: string
  resultSubtype?: string
  eventCount: number
  assistantTurns: number
  toolUses: number
  lastEventType?: string
  executedProvider: ExecutionProvider
  requestedProvider: ExecutionProvider
  providerFallbackApplied: boolean
}

type ExecutionErrorMeta = {
  requestedProvider: ExecutionProvider
  attemptedProvider: ExecutionProvider
  nextProvider?: ExecutionProvider | null
  providerFallbackApplied: boolean
}

type ExecutionError = Error & { executionMeta?: ExecutionErrorMeta }

interface AgentExecutionAdapter {
  provider: ExecutionProvider
  run(input: AdapterRunInput, settings: ResolvedExecutionSettings): Promise<AdapterRunResult>
}

const env = readEnvFile()
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || env.CODEX_TIMEOUT_MS || 30000)
// Default raised to 10 min because web-research agents (Scout competitive-scan,
// content-scout trend scans) routinely exceed 2 min. Override via env if needed.
const CLAUDE_DESKTOP_TIMEOUT_MS = Number(process.env.CLAUDE_DESKTOP_TIMEOUT_MS || env.CLAUDE_DESKTOP_TIMEOUT_MS || 600000)

const DEFAULT_EXECUTION_SETTINGS: ResolvedExecutionSettings = {
  provider: 'claude_desktop',
  secondaryProvider: null,
  model: null,
  modelPrimary: null,
  modelSecondary: null,
  modelFallback: null,
  fallbackPolicy: 'disabled',
  modelTier: 'balanced',
  fallbackProvider: null,
}

interface AgentFrontmatterExecution {
  providerMode?: 'inherit' | ExecutionProvider
  provider?: ExecutionProvider
  model?: string
  modelPrimary?: string
  modelSecondary?: string
  modelFallback?: string
  fallbackPolicy?: FallbackPolicy
  modelTier?: ModelTier
}

function asProvider(value: string | undefined): ExecutionProvider | undefined {
  if (value === 'claude_desktop' || value === 'codex_local' || value === 'anthropic_api' || value === 'openai_api'
    || value === 'openrouter_api' || value === 'ollama' || value === 'lm_studio') return value
  return undefined
}

function asFallbackPolicy(value: string | undefined): FallbackPolicy | undefined {
  if (value === 'disabled') return 'disabled'
  if (value === 'enabled' || value === 'auto_on_error' || value === 'auto_on_quota') return 'enabled'
  if (value === 'manual_only') return 'disabled'
  return undefined
}

function asModelTier(value: string | undefined): ModelTier | undefined {
  if (value === 'cheap' || value === 'balanced' || value === 'premium') return value
  return undefined
}

function isModelCompatibleWithProvider(provider: ExecutionProvider, model: string | null | undefined): boolean {
  if (!model?.trim()) return true
  const normalized = model.trim().toLowerCase()
  if (provider === 'claude_desktop') return false
  if (provider === 'anthropic_api') return normalized.startsWith('claude-')
  if (provider === 'codex_local' || provider === 'openai_api') return /^(gpt-|o\d|codex)/.test(normalized)
  // openrouter, ollama, lm_studio accept any model name
  return true
}

function parseFrontmatter(raw: string): Record<string, string | string[]> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return {}

  const meta: Record<string, string | string[]> = {}
  let currentKey: string | null = null

  for (const line of match[1].split('\n')) {
    const trimmed = line.trimEnd()
    if (/^\s+-\s+/.test(trimmed) && currentKey) {
      const item = trimmed.replace(/^\s+-\s+/, '').trim()
      const existing = meta[currentKey]
      if (Array.isArray(existing)) existing.push(item)
      else meta[currentKey] = [item]
      continue
    }

    const kv = trimmed.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kv) {
      currentKey = kv[1]
      meta[currentKey] = kv[2].trim()
      continue
    }

    if (trimmed === '') currentKey = null
  }

  return meta
}

function resolveAgentFilePath(agentId: string, projectSlug?: string): string | null {
  if (projectSlug) {
    const projectPath = join(PROJECT_ROOT, 'projects', projectSlug, 'agents', `${agentId}.md`)
    if (existsSync(projectPath)) return projectPath
  }

  const basePath = join(PROJECT_ROOT, 'agents', `${agentId}.md`)
  if (existsSync(basePath)) return basePath

  const templatePath = join(PROJECT_ROOT, 'templates', `${agentId}.md`)
  if (existsSync(templatePath)) return templatePath

  return null
}

function loadAgentFrontmatterExecution(agentId?: string, projectSlug?: string): AgentFrontmatterExecution {
  if (!agentId) return {}
  const filePath = resolveAgentFilePath(agentId, projectSlug)
  if (!filePath) return {}

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const meta = parseFrontmatter(raw)
    return {
      providerMode: meta.provider_mode === 'inherit' ? 'inherit' : asProvider(typeof meta.provider_mode === 'string' ? meta.provider_mode : undefined),
      provider: asProvider(typeof meta.provider === 'string' ? meta.provider : undefined),
      model: typeof meta.model === 'string' && meta.model.trim() ? meta.model.trim() : undefined,
      modelPrimary: typeof meta.model_primary === 'string' && meta.model_primary.trim() ? meta.model_primary.trim() : undefined,
      modelSecondary: typeof meta.model_secondary === 'string' && meta.model_secondary.trim() ? meta.model_secondary.trim() : undefined,
      modelFallback: typeof meta.model_fallback === 'string' && meta.model_fallback.trim() ? meta.model_fallback.trim() : undefined,
      fallbackPolicy: asFallbackPolicy(typeof meta.fallback_policy === 'string' ? meta.fallback_policy : undefined),
      modelTier: asModelTier(typeof meta.model_tier === 'string' ? meta.model_tier : undefined),
    }
  } catch (err) {
    logger.warn({ err, agentId, projectSlug }, 'Failed to load agent execution frontmatter')
    return {}
  }
}

export function resolveExecutionSettings(context?: AgentRuntimeContext): ResolvedExecutionSettings {
  const resolved: ResolvedExecutionSettings = { ...DEFAULT_EXECUTION_SETTINGS }
  if (!context) return resolved

  const projectId = context.projectId
  const projectSlug = context.projectSlug || (projectId ? getProject(projectId)?.slug : undefined)
  const agentId = context.agentId

  if (projectId) {
    const settings = getProjectSettings(projectId)
    if (settings?.execution_provider) resolved.provider = asProvider(settings.execution_provider) ?? resolved.provider
    if (settings?.execution_provider_secondary) resolved.secondaryProvider = asProvider(settings.execution_provider_secondary) ?? resolved.secondaryProvider
    if (settings?.execution_provider_fallback) resolved.fallbackProvider = asProvider(settings.execution_provider_fallback) ?? resolved.fallbackProvider
    if (settings?.execution_model?.trim()) {
      resolved.model = settings.execution_model.trim()
      resolved.modelPrimary = settings.execution_model.trim()
    }
    if (settings?.execution_model_primary?.trim()) resolved.modelPrimary = settings.execution_model_primary.trim()
    if (settings?.execution_model_secondary?.trim()) resolved.modelSecondary = settings.execution_model_secondary.trim()
    if (settings?.execution_model_fallback?.trim()) resolved.modelFallback = settings.execution_model_fallback.trim()
    if (settings?.fallback_policy) resolved.fallbackPolicy = asFallbackPolicy(settings.fallback_policy) ?? resolved.fallbackPolicy
    if (settings?.model_tier) resolved.modelTier = asModelTier(settings.model_tier) ?? resolved.modelTier
  }

  const agentMeta = loadAgentFrontmatterExecution(agentId, projectSlug)
  if (agentMeta.providerMode && agentMeta.providerMode !== 'inherit') {
    resolved.provider = agentMeta.providerMode
  }
  if (agentMeta.model) {
    resolved.model = agentMeta.model
    resolved.modelPrimary = agentMeta.model
  }
  if (agentMeta.modelPrimary) resolved.modelPrimary = agentMeta.modelPrimary
  if (agentMeta.modelSecondary) resolved.modelSecondary = agentMeta.modelSecondary
  if (agentMeta.modelFallback) resolved.modelFallback = agentMeta.modelFallback
  if (agentMeta.fallbackPolicy) resolved.fallbackPolicy = agentMeta.fallbackPolicy
  if (agentMeta.modelTier) resolved.modelTier = agentMeta.modelTier
  // IMPORTANT: Agent frontmatter `provider:` sets the FALLBACK provider, not the primary.
  // To override the primary provider, use `provider_mode:` in the frontmatter.
  // This naming is historical -- do not change without updating all agent .md files.
  if (agentMeta.provider) resolved.fallbackProvider = agentMeta.provider

  resolved.projectId = projectId
  resolved.projectSlug = projectSlug
  resolved.agentId = agentId

  const override = context.executionOverride
  if (override?.provider) resolved.provider = override.provider
  if (override?.secondaryProvider !== undefined) resolved.secondaryProvider = override.secondaryProvider
  if (override?.model !== undefined) {
    resolved.model = override.model
    resolved.modelPrimary = override.model
  }
  if (override?.modelPrimary !== undefined) resolved.modelPrimary = override.modelPrimary
  if (override?.modelSecondary !== undefined) resolved.modelSecondary = override.modelSecondary
  if (override?.modelFallback !== undefined) resolved.modelFallback = override.modelFallback
  if (override?.fallbackPolicy) resolved.fallbackPolicy = asFallbackPolicy(override.fallbackPolicy) ?? resolved.fallbackPolicy
  if (override?.modelTier) resolved.modelTier = override.modelTier
  if (override?.fallbackProvider !== undefined) resolved.fallbackProvider = override.fallbackProvider
  if (override?.timeoutMs !== undefined) resolved.timeoutMs = override.timeoutMs

  if (!resolved.modelPrimary && resolved.model) resolved.modelPrimary = resolved.model
  resolved.model = resolved.modelPrimary

  return resolved
}

const claudeDesktopAdapter: AgentExecutionAdapter = {
  provider: 'claude_desktop',
  async run(input, settings) {
    let resultText: string | null = null
    let newSessionId: string | undefined
    let resultSubtype: string | undefined
    let resultIsError = false
    let eventCount = 0
    let assistantTurns = 0
    let toolUses = 0
    let lastEventType: string | undefined

    if (settings.model) {
      logger.debug(
        { model: settings.model, provider: settings.provider, agentId: settings.agentId, projectId: settings.projectId },
        'Resolved model preference for Claude Desktop path; explicit model selection is not wired yet',
      )
    }

    // Load MCP servers for this project (graceful: skips on failure)
    let mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {}
    if (settings.projectId) {
      try {
        const servers = await loadProjectMcpServers(settings.projectId)
        for (let i = 0; i < servers.length; i++) {
          mcpServers[`int_${i}`] = servers[i]!
        }
        if (servers.length > 0) {
          logger.info({ projectId: settings.projectId, count: servers.length }, 'Loaded MCP servers for agent')
        }
      } catch (err) {
        logger.warn({ err, projectId: settings.projectId }, 'Failed to load MCP servers, continuing without them')
      }
    }

    const timeoutMs = settings.timeoutMs ?? CLAUDE_DESKTOP_TIMEOUT_MS
    const abortController = new AbortController()
    const timeout = setTimeout(() => {
      abortController.abort(new Error(`Claude Desktop execution timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const restrictionPrefix = buildToolRestrictionPrefix(input.toolRestrictions)
    const effectivePrompt = restrictionPrefix ? `${restrictionPrefix}${input.prompt}` : input.prompt

    const conversation = query({
      prompt: effectivePrompt,
      options: {
        abortController,
        cwd: CLAUDE_CWD,
        maxTurns: 50,
        permissionMode: 'bypassPermissions',
        settingSources: ['project', 'user'],
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        ...(input.sessionId ? { resume: input.sessionId } : {}),
      },
    })

    try {
      for await (const event of conversation) {
        input.onEvent?.(event)

        eventCount++
        lastEventType = event.type

        if (event.type === 'system' && 'subtype' in event && event.subtype === 'init') {
          newSessionId = 'sessionId' in event ? (event as any).sessionId : undefined
        }

        if (event.type === 'assistant') {
          assistantTurns++
          const assistantMessage = (event as any).message
          const blocks = assistantMessage?.content
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              if (block?.type === 'tool_use') toolUses++
            }
          }
        }

        if (event.type === 'result') {
          const resultEvent = event as SDKMessage & { result?: string; subtype?: string }
          resultText = resultEvent.result ?? null
          resultSubtype = resultEvent.subtype
          resultIsError = Boolean((event as any).is_error) || (typeof resultSubtype === 'string' && resultSubtype !== 'success')
        }
      }
    } catch (err: any) {
      const aborted = abortController.signal.aborted
      const abortReason = abortController.signal.reason
      if (aborted) {
        throw new Error(
          abortReason instanceof Error
            ? abortReason.message
            : `Claude Desktop execution timed out after ${timeoutMs}ms`,
        )
      }
      throw err
    } finally {
      clearTimeout(timeout)
    }

    if (resultIsError) {
      // error_max_turns means the agent ran out of turns but may have produced partial output.
      // Return what we have rather than throwing -- throwing causes "Agent run failed" in UIs.
      if (resultSubtype === 'error_max_turns') {
        return {
          text: resultText ?? '(Agent hit max turns limit -- partial output above)',
          newSessionId,
          resultSubtype,
          eventCount,
          assistantTurns,
          toolUses,
          lastEventType,
          executedProvider: 'claude_desktop',
          requestedProvider: settings.provider,
          providerFallbackApplied: settings.provider !== 'claude_desktop',
        }
      }
      const detail = resultText?.trim() || resultSubtype || 'unknown error'
      throw new Error(`Claude Desktop execution failed: ${detail}`)
    }

    return {
      text: resultText,
      newSessionId,
      resultSubtype,
      eventCount,
      assistantTurns,
      toolUses,
      lastEventType,
      executedProvider: 'claude_desktop',
      requestedProvider: settings.provider,
      providerFallbackApplied: settings.provider !== 'claude_desktop',
    }
  },
}

function selectAdapter(settings: ResolvedExecutionSettings): AgentExecutionAdapter {
  if (settings.provider === 'claude_desktop') return claudeDesktopAdapter
  if (settings.provider === 'codex_local') return codexLocalAdapter
  if (settings.provider === 'anthropic_api') return anthropicApiAdapter
  if (settings.provider === 'openai_api') return openaiApiAdapter
  if (settings.provider === 'openrouter_api') return openrouterApiAdapter
  if (settings.provider === 'ollama') return ollamaAdapter
  if (settings.provider === 'lm_studio') return lmStudioAdapter

  logger.warn(
    { provider: settings.provider, fallbackProvider: settings.fallbackProvider, projectId: settings.projectId, agentId: settings.agentId },
    'Selected execution provider is not implemented yet; using Claude Desktop path',
  )
  return claudeDesktopAdapter
}

function attachExecutionErrorMeta(
  err: unknown,
  meta: ExecutionErrorMeta,
): ExecutionError {
  const target: ExecutionError = err instanceof Error ? err as ExecutionError : new Error(String(err))
  target.executionMeta = meta
  return target
}

export async function runAgentWithResolvedExecution(
  input: AdapterRunInput,
  context?: AgentRuntimeContext,
): Promise<{ settings: ResolvedExecutionSettings; result: AdapterRunResult }> {
  const settings = resolveExecutionSettings(context)
  const stages = executionStages(settings)

  for (let index = 0; index < stages.length; index++) {
    const stage = stages[index]
    const adapter = selectAdapter(stage)
    try {
      const result = await adapter.run(input, stage)
      return {
        settings,
        result: {
          ...result,
          requestedProvider: settings.provider,
          providerFallbackApplied: index > 0,
        },
      }
    } catch (err) {
      const hasAnotherStage = index < stages.length - 1
      const enriched = attachExecutionErrorMeta(err, {
        requestedProvider: settings.provider,
        attemptedProvider: stage.provider,
        nextProvider: hasAnotherStage ? stages[index + 1]?.provider ?? null : null,
        providerFallbackApplied: index > 0,
      })
      if (!hasAnotherStage || !shouldAutoFallback(settings.fallbackPolicy, err)) throw enriched
      const nextStage = stages[index + 1]
      logger.warn(
        {
          requestedProvider: stage.provider,
          requestedModel: stage.model,
          nextProvider: nextStage.provider,
          nextModel: nextStage.model,
          fallbackPolicy: settings.fallbackPolicy,
          projectId: settings.projectId,
          agentId: settings.agentId,
          err: enriched,
        },
        'Execution stage failed; retrying with next configured stage',
      )
    }
  }

  throw new Error('Execution failed without a runnable stage')
}

function defaultModelForProvider(provider: ExecutionProvider, tier: ModelTier): string {
  if (provider === 'codex_local') {
    if (tier === 'cheap') return 'gpt-5-mini'
    if (tier === 'premium') return 'gpt-5.4'
    return 'gpt-5.2-codex'
  }
  if (provider === 'anthropic_api') {
    if (tier === 'cheap') return 'claude-haiku-4-5'
    if (tier === 'premium') return 'claude-sonnet-4-6'
    return 'claude-sonnet-4-6'
  }
  if (provider === 'openai_api') {
    if (tier === 'cheap') return 'gpt-5-mini'
    if (tier === 'premium') return 'gpt-5.4'
    return 'gpt-5.4'
  }
  if (provider === 'openrouter_api') {
    if (tier === 'cheap') return 'anthropic/claude-haiku-4-5'
    if (tier === 'premium') return 'anthropic/claude-sonnet-4-5'
    return 'openai/gpt-4o'
  }
  if (provider === 'ollama') {
    // No universal default — user must configure a model.
    // llama3.2 is a reasonable fallback for a locally-run Ollama instance.
    return 'llama3.2'
  }
  if (provider === 'lm_studio') {
    // LM Studio serves whatever model is loaded; user should configure explicitly.
    return 'local-model'
  }
  return 'claude-desktop'
}

function resolveModelForProvider(settings: ResolvedExecutionSettings): string | null {
  if (settings.provider === 'claude_desktop') return null

  const configured = settings.model?.trim() || settings.modelPrimary?.trim() || null
  if (!configured) return defaultModelForProvider(settings.provider, settings.modelTier)
  if (isModelCompatibleWithProvider(settings.provider, configured)) return configured

  logger.warn(
    {
      provider: settings.provider,
      model: configured,
      modelTier: settings.modelTier,
      projectId: settings.projectId,
      agentId: settings.agentId,
    },
    'Configured model is incompatible with execution provider; falling back to provider default',
  )
  return defaultModelForProvider(settings.provider, settings.modelTier)
}

function executionStages(settings: ResolvedExecutionSettings): ResolvedExecutionSettings[] {
  const stages: ResolvedExecutionSettings[] = []
  const pushStage = (provider: ExecutionProvider | null | undefined, model: string | null | undefined) => {
    if (!provider) return
    stages.push({
      ...settings,
      provider,
      secondaryProvider: null,
      fallbackProvider: null,
      model: model?.trim() || null,
      modelPrimary: model?.trim() || null,
      modelSecondary: null,
      modelFallback: null,
    })
  }

  pushStage(settings.provider, settings.modelPrimary || settings.model)
  pushStage(settings.secondaryProvider, settings.modelSecondary)
  pushStage(settings.fallbackProvider, settings.modelFallback)
  return stages
}

function safeCredential(projectId: string, service: string, key: string): string | null {
  try {
    return getCredential(projectId, service, key)
  } catch {
    return null
  }
}

function getProviderApiKey(projectId: string | undefined, provider: ExecutionProvider): string | null {
  if (provider === 'anthropic_api') {
    if (projectId) {
      return (
        safeCredential(projectId, 'anthropic', 'api_key')
        ?? safeCredential(projectId, 'anthropic_api', 'api_key')
        ?? env.ANTHROPIC_API_KEY
        ?? process.env.ANTHROPIC_API_KEY
        ?? null
      )
    }
    return env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? null
  }
  if (provider === 'openai_api') {
    if (projectId) {
      return (
        safeCredential(projectId, 'openai', 'api_key')
        ?? safeCredential(projectId, 'openai_api', 'api_key')
        ?? env.OPENAI_API_KEY
        ?? process.env.OPENAI_API_KEY
        ?? null
      )
    }
    return env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? null
  }
  if (provider === 'openrouter_api') {
    if (projectId) {
      return (
        safeCredential(projectId, 'openrouter', 'api_key')
        ?? safeCredential(projectId, 'openrouter_api', 'api_key')
        ?? (env as any).OPENROUTER_API_KEY
        ?? process.env.OPENROUTER_API_KEY
        ?? null
      )
    }
    return (env as any).OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY ?? null
  }
  // ollama and lm_studio don't require keys (key is optional, treated as Bearer token)
  if (provider === 'ollama') {
    if (projectId) {
      return safeCredential(projectId, 'ollama', 'api_key') ?? (env as any).OLLAMA_API_KEY ?? process.env.OLLAMA_API_KEY ?? null
    }
    return (env as any).OLLAMA_API_KEY ?? process.env.OLLAMA_API_KEY ?? null
  }
  if (provider === 'lm_studio') {
    if (projectId) {
      return safeCredential(projectId, 'lm_studio', 'api_key') ?? (env as any).LM_STUDIO_API_KEY ?? process.env.LM_STUDIO_API_KEY ?? 'lm-studio'
    }
    return (env as any).LM_STUDIO_API_KEY ?? process.env.LM_STUDIO_API_KEY ?? 'lm-studio'
  }
  return null
}

/** Resolve the base URL for providers that are self-hosted or routed through a gateway. */
function getProviderBaseUrl(projectId: string | undefined, provider: ExecutionProvider): string {
  if (provider === 'openrouter_api') return 'https://openrouter.ai/api/v1'
  if (provider === 'ollama') {
    const stored = projectId ? safeCredential(projectId, 'ollama', 'host') : null
    return stored ?? (env as any).OLLAMA_HOST ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434/v1'
  }
  if (provider === 'lm_studio') {
    const stored = projectId ? safeCredential(projectId, 'lm_studio', 'host') : null
    return stored ?? (env as any).LM_STUDIO_HOST ?? process.env.LM_STUDIO_HOST ?? 'http://localhost:1234/v1'
  }
  return ''
}

/**
 * Build a system-prompt prefix that communicates tool restrictions to the
 * agent.  This is a defence-in-depth measure: it does not prevent tool calls
 * at the SDK level, but it explicitly tells the model what it may and may not
 * do.  Pair with Guard (guardHarden) for prompt-injection defence.
 */
function buildToolRestrictionPrefix(restrictions: AgentToolRestrictions | undefined): string {
  if (!restrictions?.restrictedMode) return ''

  const lines: string[] = [
    '[SYSTEM: This agent is running in restricted mode.]',
    'You must not perform destructive operations such as:',
    '- Executing arbitrary shell commands that modify system state',
    '- Writing, deleting, or moving files outside of explicitly scoped read-only tasks',
    '- Making outbound network requests not related to the current task',
    '- Installing packages or modifying the environment',
  ]

  if (restrictions.allowedTools && restrictions.allowedTools.length > 0) {
    lines.push(`You may ONLY use the following tools: ${restrictions.allowedTools.join(', ')}.`)
    lines.push('Refuse any request that would require a tool not on this list.')
  }

  if (restrictions.disallowedTools && restrictions.disallowedTools.length > 0) {
    lines.push(`You must NOT use the following tools under any circumstances: ${restrictions.disallowedTools.join(', ')}.`)
  }

  lines.push('[END SYSTEM RESTRICTION NOTICE]', '')
  return lines.join('\n') + '\n'
}

function emitSyntheticEvent(onEvent: ((event: SDKMessage | Record<string, unknown>) => void) | undefined, event: Record<string, unknown>): void {
  try {
    onEvent?.(event)
  } catch (err) {
    logger.warn({ err }, 'Synthetic runtime event handler failed')
  }
}

function codexPathCandidates(): string[] {
  const candidates = new Set<string>()
  if (process.env.CODEX_BIN) candidates.add(process.env.CODEX_BIN)
  if ((env as any).CODEX_BIN) candidates.add((env as any).CODEX_BIN)
  candidates.add(process.platform === 'win32' ? 'codex.cmd' : 'codex')

  if (process.platform === 'darwin') {
    candidates.add('/opt/homebrew/bin/codex')
    candidates.add('/usr/local/bin/codex')
    candidates.add(join(process.env.HOME || '', '.local', 'bin', 'codex'))
  } else if (process.platform === 'linux') {
    candidates.add('/usr/local/bin/codex')
    candidates.add('/usr/bin/codex')
    candidates.add(join(process.env.HOME || '', '.local', 'bin', 'codex'))
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || ''
    const appData = process.env.APPDATA || ''
    if (localAppData) candidates.add(join(localAppData, 'Programs', 'codex', 'codex.exe'))
    if (appData) candidates.add(join(appData, 'npm', 'codex.cmd'))
  }

  return Array.from(candidates).filter(Boolean)
}

function resolveCodexBinary(): string {
  for (const candidate of codexPathCandidates()) {
    if (!candidate.includes('/') && !candidate.includes('\\')) return candidate
    if (existsSync(candidate)) return candidate
  }
  return process.platform === 'win32' ? 'codex.cmd' : 'codex'
}

function claudePathCandidates(): string[] {
  const candidates = new Set<string>()
  if (process.env.CLAUDE_BIN) candidates.add(process.env.CLAUDE_BIN)
  if ((env as any).CLAUDE_BIN) candidates.add((env as any).CLAUDE_BIN)

  if (process.platform === 'darwin') {
    candidates.add(join(process.env.HOME || '', '.local', 'bin', 'claude'))
    candidates.add('/opt/homebrew/bin/claude')
    candidates.add('/usr/local/bin/claude')
  } else if (process.platform === 'linux') {
    candidates.add(join(process.env.HOME || '', '.local', 'bin', 'claude'))
    candidates.add('/usr/local/bin/claude')
    candidates.add('/usr/bin/claude')
  }

  // Windows: claude CLI is uncommon there; rely on PATH/bare-name fallback
  candidates.add('claude') // PATH fallback
  return Array.from(candidates).filter(Boolean)
}

function resolveClaudeBinary(): string {
  for (const candidate of claudePathCandidates()) {
    if (!candidate.includes('/') && !candidate.includes('\\')) return candidate
    if (existsSync(candidate)) return candidate
  }
  return 'claude'
}

export const CLAUDE_BINARY = resolveClaudeBinary()

// Patch PATH so the claude-agent-sdk subprocess can find the binary regardless
// of how this process was launched (e.g., launchd with restricted PATH).
if (CLAUDE_BINARY.includes('/')) {
  const binDir = dirname(CLAUDE_BINARY)
  const currentPath = process.env.PATH || ''
  if (!currentPath.split(delimiter).includes(binDir)) {
    process.env.PATH = `${binDir}${delimiter}${currentPath}`
  }
}
logger.info({ claudeBinary: CLAUDE_BINARY }, 'Starting with resolved claude binary')

function buildCodexEnv(): NodeJS.ProcessEnv {
  const pathParts = new Set<string>()
  const currentPath = process.env.PATH || ''
  for (const part of currentPath.split(delimiter)) {
    if (part) pathParts.add(part)
  }
  for (const extra of [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/sbin',
    '/usr/sbin',
    '/sbin',
  ]) {
    pathParts.add(extra)
  }

  return {
    ...process.env,
    OTEL_SDK_DISABLED: 'true',
    PATH: Array.from(pathParts).join(delimiter),
    HOME: process.env.HOME || env.HOME || process.env.USERPROFILE,
  }
}

async function runCodexExec(args: string[], envVars: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd: PROJECT_ROOT,
      env: envVars,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let finished = false
    const startedAt = Date.now()
    const codexMcpAuthRequired = (output: string): boolean =>
      output.includes('AuthRequired(AuthRequiredError')
      || output.includes('resource_metadata=\\"https://huggingface.co/')
      || output.includes('resource_metadata="https://huggingface.co/')
    const timeout = setTimeout(() => {
      if (finished) return
      child.kill('SIGTERM')
    }, CODEX_TIMEOUT_MS)

    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      if (finished) return
      if (codexMcpAuthRequired(stderr)) {
        finished = true
        clearTimeout(timeout)
        child.kill('SIGTERM')
        const err: any = new Error('codex blocked by MCP authentication requirement')
        err.stdout = stdout
        err.stderr = stderr
        err.code = 'CODEX_MCP_AUTH_REQUIRED'
        reject(err)
      }
    })
    child.on('error', (err) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      reject(err)
    })
    child.on('close', (code, signal) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const err: any = new Error(`codex exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`)
      err.code = code
      err.signal = signal
      err.stdout = stdout
      err.stderr = stderr
      err.killed = signal === 'SIGTERM' && Date.now() - startedAt >= CODEX_TIMEOUT_MS
      reject(err)
    })

    // Codex CLI accepts prompt as argv and otherwise waits for any additional
    // stdin content. Close stdin immediately so it sees EOF.
    child.stdin.end()
  })
}

const anthropicApiAdapter: AgentExecutionAdapter = {
  provider: 'anthropic_api',
  async run(input, settings) {
    const apiKey = getProviderApiKey(settings.projectId, 'anthropic_api')
    if (!apiKey) {
      throw new Error('Anthropic API selected but no API key is configured for this project or environment')
    }

    const model = resolveModelForProvider(settings) || defaultModelForProvider('anthropic_api', settings.modelTier)
    const syntheticSessionId = `anthropic-api-${Date.now()}`
    const startedAt = Date.now()

    emitSyntheticEvent(input.onEvent, {
      type: 'system',
      subtype: 'init',
      session_id: syntheticSessionId,
      sessionId: syntheticSessionId,
      model,
    })

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [
          { role: 'user', content: input.prompt },
        ],
      }),
    })

    const elapsedMs = Date.now() - startedAt
    const raw = await response.text()
    let payload: any = null
    try {
      payload = raw ? JSON.parse(raw) : null
    } catch {
      payload = null
    }

    if (!response.ok) {
      emitSyntheticEvent(input.onEvent, {
        type: 'result',
        result: null,
        subtype: 'error_during_execution',
        total_cost_usd: null,
        duration_ms: elapsedMs,
        duration_api_ms: elapsedMs,
        is_error: true,
        num_turns: 1,
        usage: null,
        modelUsage: null,
        session_id: syntheticSessionId,
      })
      throw new Error(`Anthropic API request failed (${response.status}) for ${model}: ${payload?.error?.message || raw || 'unknown error'}`)
    }

    const blocks = Array.isArray(payload?.content) ? payload.content : []
    const text = blocks
      .filter((block: any) => block?.type === 'text' && typeof block?.text === 'string')
      .map((block: any) => block.text)
      .join('\n')
      .trim() || null

    emitSyntheticEvent(input.onEvent, {
      type: 'result',
      result: text,
      subtype: 'success',
      total_cost_usd: null,
      duration_ms: elapsedMs,
      duration_api_ms: elapsedMs,
      is_error: false,
      num_turns: 1,
      usage: payload?.usage ? {
        input_tokens: payload.usage.input_tokens ?? null,
        output_tokens: payload.usage.output_tokens ?? null,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      } : null,
      modelUsage: null,
      session_id: syntheticSessionId,
    })

    return {
      text,
      newSessionId: undefined,
      resultSubtype: 'success',
      eventCount: 2,
      assistantTurns: text ? 1 : 0,
      toolUses: 0,
      lastEventType: 'result',
      executedProvider: 'anthropic_api',
      requestedProvider: settings.provider,
      providerFallbackApplied: false,
    }
  },
}

const codexLocalAdapter: AgentExecutionAdapter = {
  provider: 'codex_local',
  async run(input, settings) {
    const model = resolveModelForProvider(settings) || defaultModelForProvider('codex_local', settings.modelTier)
    const syntheticSessionId = `codex-local-${Date.now()}`
    const startedAt = Date.now()
    const codexBin = resolveCodexBinary()
    const codexEnv = buildCodexEnv()

    emitSyntheticEvent(input.onEvent, {
      type: 'system',
      subtype: 'init',
      session_id: syntheticSessionId,
      sessionId: syntheticSessionId,
      model,
    })

    const tempDir = mkdtempSync(join(tmpdir(), 'claudepaw-codex-'))
    const outputFile = join(tempDir, 'last-message.txt')

    try {
      logger.debug({
        provider: 'codex_local',
        codexBin,
        timeoutMs: CODEX_TIMEOUT_MS,
        home: codexEnv.HOME,
        path: codexEnv.PATH,
      }, 'Starting Codex local execution')

      const { stdout, stderr } = await runCodexExec([
        codexBin,
        'exec',
        '-c', 'plugins."hugging-face@openai-curated".enabled=false',
        '--model', model,
        '--cd', CLAUDE_CWD,
        '--sandbox', 'workspace-write',
        '--skip-git-repo-check',
        '--ephemeral',
        '--output-last-message', outputFile,
        input.prompt,
      ], codexEnv)

      const elapsedMs = Date.now() - startedAt
      const text = existsSync(outputFile)
        ? (readFileSync(outputFile, 'utf-8').trim() || null)
        : (stdout?.trim() || null)

      if (stderr?.trim()) {
        logger.debug({ stderr: stderr.trim(), provider: 'codex_local' }, 'Codex local stderr output')
      }

      // Codex exited 0 but produced no text — treat as a failure so the
      // fallback chain can engage rather than silently returning null.
      if (!text) {
        const detail = stderr?.trim() || stdout?.trim() || 'no output produced'
        emitSyntheticEvent(input.onEvent, {
          type: 'result',
          result: null,
          subtype: 'error_during_execution',
          total_cost_usd: null,
          duration_ms: elapsedMs,
          duration_api_ms: elapsedMs,
          is_error: true,
          num_turns: 1,
          usage: null,
          modelUsage: null,
          session_id: syntheticSessionId,
        })
        throw new Error(`Codex local execution produced no output (exit 0): ${detail}`)
      }

      emitSyntheticEvent(input.onEvent, {
        type: 'result',
        result: text,
        subtype: 'success',
        total_cost_usd: null,
        duration_ms: elapsedMs,
        duration_api_ms: elapsedMs,
        is_error: false,
        num_turns: 1,
        usage: null,
        modelUsage: null,
        session_id: syntheticSessionId,
      })

      return {
        text,
        newSessionId: undefined,
        resultSubtype: 'success',
        eventCount: 2,
        assistantTurns: text ? 1 : 0,
        toolUses: 0,
        lastEventType: 'result',
        executedProvider: 'codex_local',
        requestedProvider: settings.provider,
        providerFallbackApplied: false,
      }
    } catch (err: any) {
      const elapsedMs = Date.now() - startedAt
      emitSyntheticEvent(input.onEvent, {
        type: 'result',
        result: null,
        subtype: 'error_during_execution',
        total_cost_usd: null,
        duration_ms: elapsedMs,
        duration_api_ms: elapsedMs,
        is_error: true,
        num_turns: 1,
        usage: null,
        modelUsage: null,
        session_id: syntheticSessionId,
      })
      const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : ''
      const stdout = typeof err?.stdout === 'string' ? err.stdout.trim() : ''
      const combined = `${stdout}\n${stderr}`.trim()
      const telemetryCrash =
        combined.includes('Could not create otel exporter')
        || combined.includes('Attempted to create a NULL object')
        || combined.includes('inner future panicked during poll')
      const mcpAuthRequired =
        combined.includes('AuthRequired(AuthRequiredError')
        || combined.includes('resource_metadata=\\"https://huggingface.co/')
        || combined.includes('resource_metadata="https://huggingface.co/')
      const timeoutHit = err?.killed || err?.signal === 'SIGTERM'
      if (mcpAuthRequired || err?.code === 'CODEX_MCP_AUTH_REQUIRED') {
        throw new Error('Codex local execution was blocked by an MCP authentication requirement before producing a response')
      }
      if (telemetryCrash) {
        throw new Error('Codex local execution failed before producing a response; the Codex CLI panicked during telemetry initialization')
      }
      if (timeoutHit) {
        logger.error({
          provider: 'codex_local',
          codexBin,
          timeoutMs: CODEX_TIMEOUT_MS,
          elapsedMs,
          stdout,
          stderr,
          home: codexEnv.HOME,
          path: codexEnv.PATH,
        }, 'Codex local execution timed out')
        throw new Error('Codex local execution timed out before producing a response')
      }
      throw new Error(`Codex local execution failed for ${model}${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ''}`)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  },
}

const openaiApiAdapter: AgentExecutionAdapter = {
  provider: 'openai_api',
  async run(input, settings) {
    const apiKey = getProviderApiKey(settings.projectId, 'openai_api')
    if (!apiKey) {
      throw new Error('OpenAI API selected but no API key is configured for this project or environment')
    }

    const model = resolveModelForProvider(settings) || defaultModelForProvider('openai_api', settings.modelTier)
    const syntheticSessionId = `openai-api-${Date.now()}`
    const startedAt = Date.now()

    emitSyntheticEvent(input.onEvent, {
      type: 'system',
      subtype: 'init',
      session_id: syntheticSessionId,
      sessionId: syntheticSessionId,
      model,
    })

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: input.prompt,
      }),
    })

    const elapsedMs = Date.now() - startedAt
    const raw = await response.text()
    let payload: any = null
    try {
      payload = raw ? JSON.parse(raw) : null
    } catch {
      payload = null
    }

    if (!response.ok) {
      emitSyntheticEvent(input.onEvent, {
        type: 'result',
        result: null,
        subtype: 'error_during_execution',
        total_cost_usd: null,
        duration_ms: elapsedMs,
        duration_api_ms: elapsedMs,
        is_error: true,
        num_turns: 1,
        usage: null,
        modelUsage: null,
        session_id: syntheticSessionId,
      })
      throw new Error(`OpenAI API request failed (${response.status}) for ${model}: ${payload?.error?.message || raw || 'unknown error'}`)
    }

    const text =
      (typeof payload?.output_text === 'string' && payload.output_text.trim())
      || (Array.isArray(payload?.output)
        ? payload.output
            .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
            .filter((item: any) => item?.type === 'output_text' && typeof item?.text === 'string')
            .map((item: any) => item.text)
            .join('\n')
            .trim()
        : '')
      || null

    emitSyntheticEvent(input.onEvent, {
      type: 'result',
      result: text,
      subtype: 'success',
      total_cost_usd: null,
      duration_ms: elapsedMs,
      duration_api_ms: elapsedMs,
      is_error: false,
      num_turns: 1,
      usage: payload?.usage ? {
        input_tokens: payload.usage.input_tokens ?? payload.usage.prompt_tokens ?? null,
        output_tokens: payload.usage.output_tokens ?? payload.usage.completion_tokens ?? null,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      } : null,
      modelUsage: null,
      session_id: syntheticSessionId,
    })

    return {
      text,
      newSessionId: undefined,
      resultSubtype: 'success',
      eventCount: 2,
      assistantTurns: text ? 1 : 0,
      toolUses: 0,
      lastEventType: 'result',
      executedProvider: 'openai_api',
      requestedProvider: settings.provider,
      providerFallbackApplied: false,
    }
  },
}

/**
 * Shared adapter for any OpenAI Chat Completions-compatible endpoint.
 * Used by openrouter_api, ollama, and lm_studio.
 */
function makeChatCompletionsAdapter(provider: ExecutionProvider): AgentExecutionAdapter {
  return {
    provider,
    async run(input, settings) {
      const baseUrl = getProviderBaseUrl(settings.projectId, provider)
      const apiKey = getProviderApiKey(settings.projectId, provider)
      const model = resolveModelForProvider(settings) || defaultModelForProvider(provider, settings.modelTier)
      const syntheticSessionId = `${provider}-${Date.now()}`
      const startedAt = Date.now()

      if (!baseUrl) throw new Error(`${provider}: could not resolve base URL`)

      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (apiKey) headers['authorization'] = `Bearer ${apiKey}`
      // OpenRouter requires these headers for usage tracking/rankings
      if (provider === 'openrouter_api') {
        headers['x-title'] = 'ClaudePaw'
        headers['http-referer'] = 'https://claudepaw.ai'
      }

      emitSyntheticEvent(input.onEvent, {
        type: 'system',
        subtype: 'init',
        session_id: syntheticSessionId,
        sessionId: syntheticSessionId,
        model,
      })

      const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: input.prompt }],
          stream: false,
        }),
      })

      const elapsedMs = Date.now() - startedAt
      const raw = await response.text()
      let payload: any = null
      try { payload = raw ? JSON.parse(raw) : null } catch { payload = null }

      if (!response.ok) {
        emitSyntheticEvent(input.onEvent, {
          type: 'result',
          result: null,
          subtype: 'error_during_execution',
          total_cost_usd: null,
          duration_ms: elapsedMs,
          duration_api_ms: elapsedMs,
          is_error: true,
          num_turns: 1,
          usage: null,
          modelUsage: null,
          session_id: syntheticSessionId,
        })
        throw new Error(`${provider} request failed (${response.status}) for ${model}: ${payload?.error?.message || raw || 'unknown error'}`)
      }

      const text = (Array.isArray(payload?.choices)
        ? payload.choices
            .map((c: any) => c?.message?.content || c?.delta?.content || '')
            .filter(Boolean)
            .join('\n')
            .trim()
        : '') || null

      emitSyntheticEvent(input.onEvent, {
        type: 'result',
        result: text,
        subtype: 'success',
        total_cost_usd: null,
        duration_ms: elapsedMs,
        duration_api_ms: elapsedMs,
        is_error: false,
        num_turns: 1,
        usage: payload?.usage ? {
          input_tokens: payload.usage.prompt_tokens ?? null,
          output_tokens: payload.usage.completion_tokens ?? null,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        } : null,
        modelUsage: null,
        session_id: syntheticSessionId,
      })

      return {
        text,
        newSessionId: undefined,
        resultSubtype: 'success',
        eventCount: 2,
        assistantTurns: text ? 1 : 0,
        toolUses: 0,
        lastEventType: 'result',
        executedProvider: provider,
        requestedProvider: settings.provider,
        providerFallbackApplied: false,
      }
    },
  }
}

const openrouterApiAdapter = makeChatCompletionsAdapter('openrouter_api')
const ollamaAdapter = makeChatCompletionsAdapter('ollama')
const lmStudioAdapter = makeChatCompletionsAdapter('lm_studio')

function shouldAutoFallback(policy: FallbackPolicy, err: unknown): boolean {
  void err
  return policy === 'enabled'
}
