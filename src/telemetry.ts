import { randomUUID } from 'node:crypto'
import { getTelemetryDb } from './telemetry-db.js'
import { logger } from './logger.js'

// ── RequestTracker ──

interface ToolCallRecord {
  tool_use_id: string | null
  tool_name: string | null
  parent_tool_use_id: string | null
  elapsed_seconds: number | null
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

    // SDKToolProgressMessage -- capture tool call data
    if (event.type === 'tool_progress') {
      this.toolCalls.push({
        tool_use_id: event.tool_use_id ?? null,
        tool_name: event.tool_name ?? null,
        parent_tool_use_id: event.parent_tool_use_id ?? null,
        elapsed_seconds: event.elapsed_time_seconds ?? null,
      })
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
        INSERT INTO tool_calls (event_id, tool_use_id, tool_name, parent_tool_use_id, elapsed_seconds)
        VALUES (?, ?, ?, ?, ?)
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
          insertTool.run(this.eventId, tc.tool_use_id, tc.tool_name, tc.parent_tool_use_id, tc.elapsed_seconds)
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
