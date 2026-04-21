import { randomUUID } from 'node:crypto'
import { getTelemetryDb } from './telemetry-db.js'
import { logger } from './logger.js'

// ── RequestTracker ──

interface ToolCallRecord {
  tool_use_id: string | null
  tool_name: string | null
  /**
   * Legacy column -- preserved for schema backcompat. Always null under the
   * current `assistant`/`user` event capture path. Would be populated if the
   * SDK ever emits nested subagent tool_use events with explicit parent ids.
   */
  parent_tool_use_id: string | null
  /**
   * Legacy column -- preserved for schema backcompat. Always null under the
   * current capture path; the real runtime duration lives in duration_ms.
   */
  elapsed_seconds: number | null
  started_at: number | null
  duration_ms: number | null
  tool_input_summary: string | null
  /** 1 = success, 0 = error, null = pending (tool_result not yet observed) */
  success: number | null
  error: string | null
}

/**
 * Redact common secret-shaped strings before persisting.
 * This is defense-in-depth; the 200-char cap still bounds exposure if a
 * novel secret shape slips past. Never log the raw tool input anywhere.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // PEM-encoded private keys -- greedy across newlines until the END marker.
  // Must run first, before any shorter pattern can match the base64 body.
  [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '[REDACTED]'],
  // Database connection string passwords: postgres://user:PASSWORD@host/db
  // (mongo/redis/mysql/mariadb/amqp use the same userinfo shape). Must run
  // before generic patterns so the colon between user and password doesn't
  // trip the api_key keyword matcher.
  [/(postgres(?:ql)?|mysql|mariadb|mongodb|redis|amqp|rediss|mongodb\+srv):\/\/([^:/\s@]+):([^@/\s]{4,})@/gi, '$1://$2:[REDACTED]@'],
  // AWS Secret Access Key adjacent to the keyword
  [/(aws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*)["']?([A-Za-z0-9/+=]{30,})["']?/gi, '$1[REDACTED]'],
  // Authorization: Bearer <token>
  [/(authorization\s*[:=]\s*)(bearer\s+)?[A-Za-z0-9._\-+/=]{16,}/gi, '$1$2[REDACTED]'],
  // API-key-like query / header values
  [/((?:api[_-]?key|x[_-]?api[_-]?key|access[_-]?token|secret[_-]?key|password)\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{8,}["']?/gi, '$1[REDACTED]'],
  // Known provider token prefixes (Anthropic, OpenAI, HuggingFace, GitHub, Slack, Google, AWS)
  [/\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g, '[REDACTED]'],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED]'],
  [/\bhf_[A-Za-z0-9]{30,}\b/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_\-]{30,}\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  // Telegram bot token: <bot_id>:<35-char-base64-ish hash>. Matches inside URLs
  // like /bot1234567890:HASH/sendMessage. `(?<!\d)` keeps digit-runs from
  // over-extending but still allows letters (like `bot`) to precede the id.
  [/(?<!\d)\d{8,12}:[A-Za-z0-9_\-]{35}(?![A-Za-z0-9_\-])/g, '[REDACTED]'],
]

export function summarizeToolInput(input: unknown, maxChars = 200): string {
  let raw: string
  try {
    raw = typeof input === 'string' ? input : JSON.stringify(input)
  } catch {
    return '[unserializable]'
  }
  if (raw == null) return ''

  let redacted = raw
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement)
  }

  if (redacted.length <= maxChars) return redacted
  return redacted.slice(0, maxChars - 1) + '…'
}

export class RequestTracker {
  readonly eventId: string

  private chatId: string
  private source: 'telegram' | 'scheduler' | 'api' | 'dashboard'
  private promptSummary: string

  private receivedAt: number
  private memoryInjectedAt: number | null = null
  private agentStartedAt: number | null = null
  private agentEndedAt: number | null = null
  private responseSentAt: number | null = null

  private sessionId: string | null = null
  private model: string | null = null
  private resultSummary: string | null = null

  private inputTokens: number | null = null
  private outputTokens: number | null = null
  private cacheReadTokens: number | null = null
  private cacheCreationTokens: number | null = null
  private totalCostUsd: number | null = null
  private durationMs: number | null = null
  private durationApiMs: number | null = null
  private numTurns: number | null = null
  private isError = 0
  private modelUsageJson: string | null = null
  private requestedProvider: string | null = null
  private executedProvider: string | null = null
  private providerFallbackApplied = 0

  promptText: string | null = null
  resultText: string | null = null
  agentId: string | null = null

  private toolCalls: ToolCallRecord[] = []

  private projectId: string

  constructor(chatId: string, source: 'telegram' | 'scheduler' | 'api' | 'dashboard', promptSummary: string, projectId = 'default') {
    this.eventId = randomUUID()
    this.chatId = chatId
    this.source = source
    this.promptSummary = promptSummary
    this.projectId = projectId
    this.receivedAt = Date.now()
  }

  setPromptText(text: string): void { this.promptText = text }
  setResultText(text: string): void { this.resultText = text }
  setAgentId(id: string): void { this.agentId = id }
  setExecutionMeta(meta: {
    requestedProvider?: string
    executedProvider?: string
    providerFallbackApplied?: boolean
  }): void {
    this.requestedProvider = meta.requestedProvider ?? this.requestedProvider
    this.executedProvider = meta.executedProvider ?? this.executedProvider
    this.providerFallbackApplied = meta.providerFallbackApplied ? 1 : 0
  }

  markMemoryInjected(): this {
    this.memoryInjectedAt = Date.now()
    return this
  }

  markAgentStarted(): this {
    this.agentStartedAt = Date.now()
    return this
  }

  markAgentEnded(): this {
    this.agentEndedAt = Date.now()
    return this
  }

  markResponseSent(): this {
    this.responseSentAt = Date.now()
    return this
  }

  /**
   * Process a single SDK event from the for-await loop.
   * Types verified against @anthropic-ai/claude-agent-sdk coreTypes.d.ts:
   * - SDKSystemMessage: { type: 'system', subtype: 'init', model, session_id, ... }
   * - SDKToolProgressMessage: { type: 'tool_progress', tool_use_id, tool_name, parent_tool_use_id, elapsed_time_seconds, session_id }
   * - SDKResultMessage: { type: 'result', total_cost_usd, duration_ms, duration_api_ms, is_error, num_turns, result, usage, modelUsage, session_id }
   */
  recordSdkEvent(event: any): void {
    // SDKSystemMessage init -- extract model and session_id
    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.session_id === 'string') {
        this.sessionId = event.session_id
      }
      if (typeof event.model === 'string') {
        this.model = event.model
      }
    }

    // Assistant message -- capture each tool_use block as a pending tool call.
    // The Claude Agent SDK wraps tool invocations inside assistant events; the
    // legacy `tool_progress` path is not emitted for our current SDK wiring, so
    // this is the sole hook point that works end-to-end.
    if (event.type === 'assistant') {
      const blocks = (event as any).message?.content
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block && block.type === 'tool_use') {
            const toolUseId = typeof block.id === 'string' ? block.id : null
            const toolName = typeof block.name === 'string' ? block.name : null
            this.toolCalls.push({
              tool_use_id: toolUseId,
              tool_name: toolName,
              parent_tool_use_id: (event as any).parent_tool_use_id ?? null,
              elapsed_seconds: null,
              started_at: Date.now(),
              duration_ms: null,
              tool_input_summary: summarizeToolInput(block.input),
              success: null,
              error: null,
            })
          }
        }
      }
    }

    // User message -- may contain tool_result blocks that close out prior tool_use
    // records. Match by tool_use_id, stamp duration_ms + success/error. Unmatched
    // tool_result blocks are ignored (defensive: SDK could theoretically emit
    // results without a matching use if the assistant event was dropped).
    if (event.type === 'user') {
      const blocks = (event as any).message?.content
      if (Array.isArray(blocks)) {
        const now = Date.now()
        for (const block of blocks) {
          if (block && block.type === 'tool_result') {
            const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null
            if (!toolUseId) continue
            const pending = this.toolCalls.find(
              (tc) => tc.tool_use_id === toolUseId && tc.success === null,
            )
            if (!pending) continue
            pending.duration_ms = pending.started_at != null ? now - pending.started_at : null
            const isError = Boolean(block.is_error)
            pending.success = isError ? 0 : 1
            if (isError) {
              // tool_result.content may be a string OR an array of structured
              // content blocks (SDK emits `[{ type: 'text', text: '...' }]`
              // for WebFetch / computer-use errors). Flatten to text first so
              // the persisted `error` column doesn't contain JSON wrappers.
              // Then route through summarizeToolInput so embedded tokens,
              // auth headers, DB URLs, or PEM blocks get redacted + truncated.
              const flat = Array.isArray(block.content)
                ? block.content
                    .map((b: any) => (b && typeof b.text === 'string' ? b.text : ''))
                    .filter(Boolean)
                    .join(' ')
                : block.content
              pending.error = summarizeToolInput(flat)
            }
          }
        }
      }
    }

    // SDKResultMessage -- fields are directly on the event, NOT nested under event.result
    // event.result is the result string; event.total_cost_usd, event.usage, etc. are top-level
    if (event.type === 'result') {
      this.totalCostUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null
      this.durationMs = typeof event.duration_ms === 'number' ? event.duration_ms : null
      this.durationApiMs = typeof event.duration_api_ms === 'number' ? event.duration_api_ms : null
      this.numTurns = typeof event.num_turns === 'number' ? event.num_turns : null
      this.isError = event.is_error ? 1 : 0

      if (typeof event.result === 'string') {
        this.resultSummary = event.result.slice(0, 500)
      }

      if (typeof event.session_id === 'string') {
        this.sessionId = event.session_id
      }

      const usage = event.usage as Record<string, any> | undefined
      if (usage) {
        this.inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : null
        this.outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : null
        this.cacheReadTokens = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : null
        this.cacheCreationTokens = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : null
      }

      if (event.modelUsage != null) {
        try {
          this.modelUsageJson = JSON.stringify(event.modelUsage)
        } catch {
          this.modelUsageJson = null
        }
      }
    }
  }

  /** Return all fields as a plain object for syncing to the Hostinger DB. */
  toEventRow(): Record<string, unknown> {
    return {
      event_id: this.eventId,
      project_id: this.projectId,
      chat_id: this.chatId,
      session_id: this.sessionId,
      received_at: this.receivedAt,
      memory_injected_at: this.memoryInjectedAt,
      agent_started_at: this.agentStartedAt,
      agent_ended_at: this.agentEndedAt,
      response_sent_at: this.responseSentAt,
      prompt_summary: this.promptSummary,
      result_summary: this.resultSummary,
      model: this.model,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cache_read_tokens: this.cacheReadTokens,
      cache_creation_tokens: this.cacheCreationTokens,
      total_cost_usd: this.totalCostUsd,
      duration_ms: this.durationMs,
      duration_api_ms: this.durationApiMs,
      num_turns: this.numTurns,
      is_error: this.isError,
      source: this.source,
      model_usage_json: this.modelUsageJson,
      prompt_text: this.promptText,
      result_text: this.resultText,
      agent_id: this.agentId,
      requested_provider: this.requestedProvider,
      executed_provider: this.executedProvider,
      provider_fallback_applied: this.providerFallbackApplied,
      // Feature #17: ship tool_calls so the server can persist them alongside
      // the event. Empty array if the run didn't use any tools. The server
      // tolerates missing or non-array values gracefully.
      tool_calls: this.toolCalls.map(tc => ({
        tool_use_id: tc.tool_use_id,
        tool_name: tc.tool_name,
        parent_tool_use_id: tc.parent_tool_use_id,
        elapsed_seconds: tc.elapsed_seconds,
        started_at: tc.started_at,
        duration_ms: tc.duration_ms,
        tool_input_summary: tc.tool_input_summary,
        success: tc.success,
        error: tc.error,
      })),
    }
  }

  /** Write agent_events + tool_calls rows in a single transaction */
  finalize(): void {
    try {
      const d = getTelemetryDb()

      const insertEvent = d.prepare(`
        INSERT INTO agent_events (
          event_id, project_id, chat_id, session_id,
          received_at, memory_injected_at, agent_started_at, agent_ended_at, response_sent_at,
          prompt_summary, result_summary, model,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          total_cost_usd, duration_ms, duration_api_ms, num_turns, is_error,
          source, model_usage_json,
          prompt_text, result_text, agent_id,
          requested_provider, executed_provider, provider_fallback_applied
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?, ?
        )
      `)

      const insertTool = d.prepare(`
        INSERT INTO tool_calls (
          event_id, tool_use_id, tool_name, parent_tool_use_id, elapsed_seconds,
          started_at, duration_ms, tool_input_summary, success, error
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      const runTransaction = d.transaction(() => {
        insertEvent.run(
          this.eventId, this.projectId, this.chatId, this.sessionId,
          this.receivedAt, this.memoryInjectedAt, this.agentStartedAt, this.agentEndedAt, this.responseSentAt,
          this.promptSummary, this.resultSummary, this.model,
          this.inputTokens, this.outputTokens, this.cacheReadTokens, this.cacheCreationTokens,
          this.totalCostUsd, this.durationMs, this.durationApiMs, this.numTurns, this.isError,
          this.source, this.modelUsageJson,
          this.promptText, this.resultText, this.agentId,
          this.requestedProvider, this.executedProvider, this.providerFallbackApplied,
        )

        for (const tc of this.toolCalls) {
          insertTool.run(
            this.eventId,
            tc.tool_use_id,
            tc.tool_name,
            tc.parent_tool_use_id,
            tc.elapsed_seconds,
            tc.started_at,
            tc.duration_ms,
            tc.tool_input_summary,
            tc.success,
            tc.error,
          )
        }
      })

      runTransaction()
    } catch (err) {
      logger.error({ err, eventId: this.eventId }, 'Failed to finalize telemetry event')
    }
  }
}

// ── Standalone emitters (fire-and-forget) ──

export function startRequest(
  chatId: string,
  source: 'telegram' | 'scheduler' | 'api' | 'dashboard',
  promptSummary: string,
  promptText?: string,
  projectId = 'default'
): RequestTracker {
  const tracker = new RequestTracker(chatId, source, promptSummary, projectId)
  if (promptText) tracker.setPromptText(promptText)
  return tracker
}

export function recordVoiceEvent(
  direction: 'stt' | 'tts',
  startedAt: number,
  endedAt: number,
  success: boolean,
  error?: string,
  audioSize?: number,
  eventId?: string
): void {
  try {
    getTelemetryDb()
      .prepare(
        `INSERT INTO voice_events (project_id, event_id, direction, started_at, ended_at, duration_ms, success, error_message, audio_size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'claudepaw',
        eventId ?? null,
        direction,
        startedAt,
        endedAt,
        endedAt - startedAt,
        success ? 1 : 0,
        error ?? null,
        audioSize ?? null
      )
  } catch (err) {
    logger.error({ err }, 'Failed to record voice event')
  }
}

export function recordError(
  subsystem: string,
  severity: 'info' | 'warn' | 'error' | 'fatal',
  message: string,
  stack?: string,
  context?: Record<string, unknown>,
  eventId?: string
): void {
  try {
    let contextJson: string | null = null
    if (context != null) {
      try {
        contextJson = JSON.stringify(context)
      } catch {
        contextJson = null
      }
    }

    getTelemetryDb()
      .prepare(
        `INSERT INTO error_log (project_id, subsystem, severity, message, stack, context_json, event_id, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('claudepaw', subsystem, severity, message, stack ?? null, contextJson, eventId ?? null, Date.now())
  } catch (err) {
    logger.error({ err }, 'Failed to record error log')
  }
}

export interface SystemHealthSnapshot {
  cpu_percent: number
  memory_used_bytes: number
  memory_total_bytes: number
  disk_used_bytes: number
  disk_total_bytes: number
  uptime_seconds: number
  node_rss_bytes: number
  bot_pid: number
  bot_alive: boolean
}

export function recordSystemHealth(snapshot: SystemHealthSnapshot): void {
  try {
    getTelemetryDb()
      .prepare(
        `INSERT INTO system_health (
          project_id, cpu_percent, memory_used_bytes, memory_total_bytes,
          disk_used_bytes, disk_total_bytes, uptime_seconds,
          node_rss_bytes, bot_pid, bot_alive, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'claudepaw',
        snapshot.cpu_percent,
        snapshot.memory_used_bytes,
        snapshot.memory_total_bytes,
        snapshot.disk_used_bytes,
        snapshot.disk_total_bytes,
        snapshot.uptime_seconds,
        snapshot.node_rss_bytes,
        snapshot.bot_pid,
        snapshot.bot_alive ? 1 : 0,
        Date.now()
      )
  } catch (err) {
    logger.error({ err }, 'Failed to record system health')
  }
}
