import { randomUUID } from 'node:crypto'
import { TYPING_REFRESH_MS } from './config.js'
import { logger } from './logger.js'
import { guardChain } from './guard/index.js'
import { parseActionItemsFromAgentOutput, ingestParsedItems } from './action-items.js'
import { recordError } from './telemetry.js'
import type { AgentRuntimeContext } from './agent-runtime.js'
import { runAgentWithResolvedExecution } from './agent-runtime.js'

export interface ActionPlanContext {
  projectId: string
  source: string  // agent id or origin tag
}

export interface AgentResult {
  text: string | null
  newSessionId?: string
  canary?: string
  delimiterID?: string
  /** Subtype of the SDK `result` event (e.g. 'success', 'error_max_turns', 'error_during_execution') */
  resultSubtype?: string
  /** Human-readable reason describing why text is null (only set when text is null) */
  emptyReason?: string
  /** Total number of SDK events observed during the run */
  eventCount?: number
  /** Number of assistant turns observed */
  assistantTurns?: number
  /** Number of tool_use blocks observed */
  toolUses?: number
  /** Number of seconds the agent ran for */
  durationSec?: number
  /** Resolved execution provider requested by settings */
  requestedProvider?: string
  /** Actual execution provider used for this run */
  executedProvider?: string
  /** True when runtime downgraded to another provider */
  providerFallbackApplied?: boolean
  /** True when the guard output pass blocked the result. */
  blocked?: boolean
  /** Why the guard blocked it. Only set when blocked is true. */
  blockReason?: string
  /** Guard layers that triggered the block. Only set when blocked is true. */
  blockedLayers?: string[]
}

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  guardHarden: boolean = true,
  onEvent?: (event: any) => void,
  actionPlan?: ActionPlanContext,
  runtimeContext?: AgentRuntimeContext,
): Promise<AgentResult> {
  let resultText: string | null = null
  let newSessionId: string | undefined
  let resultSubtype: string | undefined
  let eventCount = 0
  let assistantTurns = 0
  let toolUses = 0
  let lastEventType: string | undefined
  let requestedProvider: string | undefined
  let executedProvider: string | undefined
  let providerFallbackApplied: boolean | undefined
  const startMs = Date.now()

  // Fire onTyping on a regular interval while the agent is running
  let typingInterval: ReturnType<typeof setInterval> | undefined
  if (onTyping) {
    onTyping()
    typingInterval = setInterval(onTyping, TYPING_REFRESH_MS)
  }

  let canary: string | undefined
  let delimiterID: string | undefined

  try {
    // T3-C: gate checks run before any agent work.
    // Kill switch is GLOBAL (not project-scoped); always check regardless of
    // whether the call has a projectId. Cost gate is per-project; when no
    // projectId is supplied we attribute to 'default' so spend is still gated
    // and caps cannot be skipped by omitting the tag.
    const gateProjectId = actionPlan?.projectId || runtimeContext?.projectId || 'default'

    const { checkKillSwitch } = await import('./cost/kill-switch-client.js')
    const sw = await checkKillSwitch()
    if (sw) {
      const msg = `System is paused. Kill switch tripped: ${sw.reason}. Ask an admin to clear it from the dashboard.`
      return buildRefusalResult(msg, `kill-switch active: ${sw.reason}`, startMs)
    }

    let capOverride: 'ollama' | null = null

    // POOL GATE — account-wide Anthropic Agent SDK Credit Pool ($200/mo Max 20x,
    // metered post-June-15 2026). Checked before the per-project gate.
    const { getPoolGateStatus, getCostGateStatus } = await import('./cost/cost-gate.js')
    const pool = await getPoolGateStatus()
    if (pool.action === 'refuse') {
      const msg = isTraderRun && pool.unavailable
        ? 'Trader credit-pool gate is unavailable. Trader run refused until dashboard cost controls recover.'
        : isTraderRun
        ? `Anthropic credit pool exhausted: $${pool.spend_usd.toFixed(2)} of $${pool.cap_usd} (global hard-stop). Trader paused until the pool resets on the 1st (paper phase: no overflow billing).`
        : `Non-trader credit budget reached ($${(pool.nontrader_spend_usd ?? pool.spend_usd).toFixed(2)} of $${pool.nontrader_cap_usd ?? pool.cap_usd}; $${pool.reserve_usd ?? 0} reserved for trader). Non-trader Anthropic runs refused until the pool resets.`
      const reason = pool.unavailable ? 'trader credit-pool gate unavailable' : `agent SDK pool ${pool.scope ?? 'global'} hard-stop`
      return buildRefusalResult(msg, reason, startMs)
    }
    if (pool.action === 'override_to_ollama') capOverride = 'ollama'

    // PER-PROJECT GATE — unchanged. Layered on top of the pool gate so a single
    // project can still be capped tighter than the pool allows.
    const status = await getCostGateStatus(gateProjectId)
    if (status.action === 'refuse') {
      if (isTraderRun && status.unavailable) {
        return buildRefusalResult(
          'Trader project cost gate is unavailable. Trader run refused until dashboard cost controls recover.',
          'trader project cost gate unavailable',
          startMs,
        )
      }
      const scope = status.triggering_cap === 'daily' ? 'Daily' : 'Monthly'
      const capAmount = status.monthly_cap_usd ?? status.daily_cap_usd ?? 0
      const pct = status.percent_of_cap.toFixed(0)
      const msg = `${scope} cost cap reached (${pct}% of $${capAmount}). Agent refused to run. Raise cap in Settings.`
      return buildRefusalResult(msg, `cost cap exceeded at ${pct}%`, startMs)
    }
    if (status.action === 'override_to_ollama') capOverride = 'ollama'

    let finalMessage = message

    if (guardHarden) {
      const hardened = guardChain.hardenPrompt('', message)
      finalMessage = `${hardened.systemPrompt}\n\n${message}`
      canary = hardened.canary
      delimiterID = hardened.delimiterID
    }

    const baseCtx = runtimeContext ?? (actionPlan?.projectId ? { projectId: actionPlan.projectId } : undefined)
    const effectiveRuntimeContext = capOverride
      ? { ...(baseCtx ?? {}), executionOverride: { ...((baseCtx as any)?.executionOverride ?? {}), provider: capOverride as any } }
      : baseCtx
    const { settings, result } = await runAgentWithResolvedExecution(
      {
        prompt: finalMessage,
        sessionId,
        onEvent,
      },
      effectiveRuntimeContext,
    )

    resultText = result.text
    newSessionId = result.newSessionId
    resultSubtype = result.resultSubtype
    requestedProvider = settings.provider
    executedProvider = result.executedProvider
    providerFallbackApplied = result.providerFallbackApplied
    eventCount = result.eventCount
    assistantTurns = result.assistantTurns
    toolUses = result.toolUses
    lastEventType = result.lastEventType

    logger.info({
      sessionIdProvided: !!sessionId,
      sessionIdResumed: sessionId,
      resultNewSessionId: newSessionId,
      resultKeys: result ? Object.keys(result) : [],
      executedProvider,
    }, 'agent.session.trace')

    logger.debug(
      {
        requestedProvider: settings.provider,
        executedProvider: result.executedProvider,
        providerFallbackApplied: result.providerFallbackApplied,
        resultLength: resultText?.length,
        subtype: resultSubtype,
      },
      'Agent result received',
    )
  } catch (err) {
    logger.error({ err }, 'Agent query failed')
    throw err
  } finally {
    if (typingInterval) clearInterval(typingInterval)
  }

  const durationSec = Math.round((Date.now() - startMs) / 1000)

  // Guard output gate. hardenPrompt issued a canary and the L6 validator was
  // already written; nothing consumed either one before this
  // (.reviews/loop1-autonomy.md, primitive 04, HIGH). A blocked run returns no
  // text, is marked blocked, and lands in error_log.
  let blocked = false
  let blockReason: string | undefined
  let blockedLayers: string[] | undefined
  if (guardHarden && canary && resultText) {
    try {
      const post = await guardChain.postProcess(resultText, message, {
        requestId: randomUUID(),
        canary,
        delimiterID: delimiterID ?? '',
        chatId: actionPlan?.projectId ?? 'agent',
      })
      if (post.blocked) {
        blocked = true
        blockReason = post.blockReason ?? 'guard output validation blocked the response'
        blockedLayers = post.triggeredLayers
        recordError('guard', 'error', blockReason, undefined, {
          layers: post.triggeredLayers, projectId: actionPlan?.projectId,
        })
        logger.error({ layers: post.triggeredLayers, blockReason }, 'agent result blocked by guard')
        resultText = null
      }
    } catch (err) {
      // A broken guard must not look identical to a guard that passed
      // everything. Fail closed by default so a real bug shows up in
      // error_log instead of silently letting every result through. The one
      // exception is a sidecar network error: postProcess already degrades
      // gracefully for its own L7 sidecar call, but this guards against a
      // future change that lets a network failure escape that internal
      // try/catch, in which case a down sidecar should not block agent output.
      if (isSidecarNetworkError(err)) {
        logger.warn({ err }, 'guard postProcess sidecar unreachable, result passed through')
      } else {
        blocked = true
        blockReason = 'guard output validation threw and was treated as blocked'
        recordError('guard', 'error', blockReason, err instanceof Error ? err.stack : undefined, {
          projectId: actionPlan?.projectId,
        })
        logger.error({ err }, 'guard postProcess threw, treating result as blocked')
        resultText = null
      }
    }
  }

  // Build a descriptive reason if no text was returned
  let emptyReason: string | undefined
  if (resultText === null || resultText === '') {
    if (resultSubtype && resultSubtype !== 'success') {
      // SDK terminated with a non-success result
      emptyReason = `Agent ended with subtype "${resultSubtype}" (no text). Ran ${assistantTurns} assistant turns, ${toolUses} tool calls, ${eventCount} events, ${durationSec}s.`
    } else if (resultSubtype === 'success') {
      // Success but the result string was empty
      emptyReason = `Agent finished successfully but produced an empty result (likely the model returned no text after using ${toolUses} tools). ${assistantTurns} turns, ${durationSec}s.`
    } else if (eventCount === 0) {
      emptyReason = 'Agent produced zero SDK events. The query call may have failed silently.'
    } else {
      emptyReason = `Agent stream ended without a result event. Last event type: "${lastEventType ?? 'unknown'}", ${assistantTurns} turns, ${eventCount} events, ${durationSec}s. The session likely hit maxTurns (50) or was killed.`
    }
  }

  // Auto-ingest action items from the agent's output if context was provided.
  // Legacy agents can propose items just by including a `## Action Items` markdown
  // block in their response. New items always land as `proposed` and require human
  // approval before anything runs.
  if (actionPlan && resultText && !blocked) {
    try {
      const parsed = parseActionItemsFromAgentOutput(resultText)
      if (parsed.length > 0) {
        const ids = ingestParsedItems(parsed, {
          project_id: actionPlan.projectId,
          source: actionPlan.source,
          proposed_by: actionPlan.source,
        })
        logger.info({ projectId: actionPlan.projectId, source: actionPlan.source, count: ids.length }, 'ingested action items from agent output')
      }
    } catch (err) {
      logger.warn({ err }, 'failed to ingest action items from agent output')
    }
  }

  return {
    text: resultText,
    newSessionId,
    canary,
    delimiterID,
    resultSubtype,
    emptyReason,
    eventCount,
    assistantTurns,
    toolUses,
    durationSec,
    requestedProvider,
    executedProvider,
    providerFallbackApplied,
    blocked,
    blockReason,
    blockedLayers,
  }
}

function isSidecarNetworkError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code
  const name = (err as { name?: string } | undefined)?.name
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT') return true
  if (name === 'AbortError') return true
  const message = err instanceof Error ? err.message : String(err)
  return /ECONNREFUSED|ETIMEDOUT/.test(message)
}

function buildRefusalResult(text: string, emptyReason: string, startMs: number): AgentResult {
  return {
    text,
    emptyReason,
    resultSubtype: 'refused',
    eventCount: 0,
    assistantTurns: 0,
    toolUses: 0,
    durationSec: Math.round((Date.now() - startMs) / 1000),
  }
}
