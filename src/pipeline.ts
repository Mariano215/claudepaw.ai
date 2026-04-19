// ---------------------------------------------------------------------------
// Platform-agnostic message processing pipeline
//
// Extracted from bot.ts. Receives normalized IncomingMessage objects from
// any channel, runs them through the agent system, and sends responses
// back through the originating channel.
// ---------------------------------------------------------------------------

import type { Channel, IncomingMessage } from './channels/types.js'
import { runAgent } from './agent.js'
import {
  getSession,
  setSession,
  clearSession,
  listTasks,
  getChatProject,
  setChatProject,
  listProjects,
  getProjectByName,
  getProjectBySlug,
  getProject,
  logChannelMessage,
} from './db.js'
import { buildMemoryContext, saveConversationTurn } from './memory.js'
import { reportFeedItem, reportAgentStatus, reportMetric, reportChannelLog } from './dashboard.js'
import { transcribeAudio, synthesizeSpeech, voiceCapabilities } from './voice.js'
import { routeMessage } from './agent-router.js'
import { getSoul, getAllSouls, buildAgentPrompt } from './souls.js'
import { getFormatter, splitMessage } from './channels/formatters.js'
import { TYPING_REFRESH_MS, DASHBOARD_URL as DASHBOARD_BASE_URL, BOT_API_TOKEN, PROJECT_ROOT } from './config.js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger.js'
import { startRequest } from './telemetry.js'
import { guardChain } from './guard/index.js'
import { GUARD_CONFIG } from './guard/config.js'
import { fireAgentCompleted, fireGuardBlocked } from './webhooks/index.js'
import { listPlugins } from './plugins/registry.js'
import { extractAndLogFindings } from './research.js'
import { handleTodoCommand } from './commands/todo.js'

type ExecutionFailureMeta = {
  requestedProvider?: string
  attemptedProvider?: string
  nextProvider?: string | null
  providerFallbackApplied?: boolean
}

function extractExecutionFailureMeta(err: unknown): ExecutionFailureMeta {
  if (!err || typeof err !== 'object') return {}
  const meta = (err as { executionMeta?: ExecutionFailureMeta }).executionMeta
  if (!meta || typeof meta !== 'object') return {}
  return meta
}

function buildFailureSummary(err: unknown, meta: ExecutionFailureMeta): string {
  const detail = err instanceof Error ? err.message : String(err)
  const providerBits = [
    meta.requestedProvider ? `requested=${meta.requestedProvider}` : null,
    meta.attemptedProvider ? `attempted=${meta.attemptedProvider}` : null,
    meta.nextProvider ? `next=${meta.nextProvider}` : null,
    meta.providerFallbackApplied ? 'fallback_applied=yes' : null,
  ].filter(Boolean)
  return providerBits.length > 0
    ? `Message handling failed (${providerBits.join(', ')}): ${detail}`
    : `Message handling failed: ${detail}`
}

// ---------------------------------------------------------------------------
// Per-channel rate limiting
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000  // 1 minute window
const RATE_LIMIT_MAX = 20            // max 20 messages per window per composite ID

interface RateBucket {
  count: number
  resetAt: number
}

const rateBuckets = new Map<string, RateBucket>()

function checkRateLimit(compositeId: string): boolean {
  const now = Date.now()
  const bucket = rateBuckets.get(compositeId)

  if (!bucket || now >= bucket.resetAt) {
    if (rateBuckets.size >= 10_000) return false  // reject all new IDs until cleanup
    rateBuckets.set(compositeId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }

  bucket.count++
  return bucket.count <= RATE_LIMIT_MAX
}

// Periodic cleanup of stale buckets (every 5 minutes)
setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(key)
  }
}, 300_000)

// ---------------------------------------------------------------------------
// Channel display helpers
// ---------------------------------------------------------------------------

const CHANNEL_BOT_NAMES: Record<string, string> = {
  'telegram': '@YourBotName',
  // Add per-project bot mappings here
  // Example: 'telegram:my-project': '@MyProjectBot',
}

function channelDisplayName(channelId: string): string {
  if (channelId.startsWith('telegram')) return 'Telegram'
  if (channelId.startsWith('whatsapp')) return 'WhatsApp'
  if (channelId.startsWith('discord')) return 'Discord'
  if (channelId.startsWith('slack')) return 'Slack'
  if (channelId.startsWith('imessage')) return 'iMessage'
  return channelId
}

// ---------------------------------------------------------------------------
// Voice mode tracking (shared across channels)
// ---------------------------------------------------------------------------

const voiceModeChats = new Set<string>()

export function toggleVoiceMode(compositeId: string): boolean {
  if (voiceModeChats.has(compositeId)) {
    voiceModeChats.delete(compositeId)
    return false
  }
  voiceModeChats.add(compositeId)
  return true
}

export function isVoiceMode(compositeId: string): boolean {
  return voiceModeChats.has(compositeId)
}

// ---------------------------------------------------------------------------
// Project context builder
// ---------------------------------------------------------------------------

function buildProjectContext(
  project: { id: string; name: string; slug: string },
  projectSlug: string,
): string {
  const agentDir = `projects/${projectSlug}/agents`
  const lines = [
    `[Active Project: ${project.name}]`,
    `Project ID: ${project.id}`,
    `Agent definitions: ${PROJECT_ROOT}/${agentDir}/`,
    `This message arrived via the ${project.name} Telegram bot.`,
    `All responses should be in context of the ${project.name} project.`,
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Command handling (shared across channels)
// ---------------------------------------------------------------------------

export interface CommandResult {
  handled: boolean
  response?: string
}

/**
 * Handle common commands that work across all channels.
 * Returns { handled: true, response } if the command was processed,
 * or { handled: false } if it should go to the agent pipeline.
 */
export async function handleCommand(
  compositeId: string,
  channelId: string,
  chatId: string,
  command: string,
  args: string,
): Promise<CommandResult> {
  const projectId = getChatProject(compositeId, chatId)

  // Log inbound command
  logChannelMessage({
    direction: 'in',
    channel: channelId,
    channelName: channelDisplayName(channelId),
    botName: CHANNEL_BOT_NAMES[channelId] ?? channelId,
    projectId,
    chatId,
    senderName: chatId,
    content: `/${command}${args ? ' ' + args : ''}`,
    contentType: 'command',
    isVoice: false,
    isGroup: chatId.startsWith('-'),
  })
  reportChannelLog({
    direction: 'in',
    channel: channelId,
    channelName: channelDisplayName(channelId),
    botName: CHANNEL_BOT_NAMES[channelId] ?? channelId,
    projectId,
    chatId,
    senderName: chatId,
    content: `/${command}${args ? ' ' + args : ''}`,
    contentType: 'command',
    isVoice: false,
    isGroup: chatId.startsWith('-'),
  })

  const result = await _handleCommandInner(compositeId, channelId, chatId, command, args, projectId)

  // Log outbound response
  if (result.handled && result.response) {
    logChannelMessage({
      direction: 'out',
      channel: channelId,
      channelName: channelDisplayName(channelId),
      botName: CHANNEL_BOT_NAMES[channelId] ?? channelId,
      projectId,
      chatId,
      senderName: 'system',
      content: result.response,
      contentType: 'command_response',
      isVoice: false,
      isGroup: chatId.startsWith('-'),
    })
    reportChannelLog({
      direction: 'out',
      channel: channelId,
      channelName: channelDisplayName(channelId),
      botName: CHANNEL_BOT_NAMES[channelId] ?? channelId,
      projectId,
      chatId,
      senderName: 'system',
      content: result.response,
      contentType: 'command_response',
      isVoice: false,
      isGroup: chatId.startsWith('-'),
    })
  }

  return result
}

async function _handleCommandInner(
  compositeId: string,
  channelId: string,
  chatId: string,
  command: string,
  args: string,
  projectId: string,
): Promise<CommandResult> {
  switch (command) {
    case 'newchat':
    case 'forget': {
      clearSession(compositeId)
      return { handled: true, response: 'Session cleared. Starting fresh.' }
    }

    case 'todo': {
      const result = await handleTodoCommand({
        args,
        projectId,
        actor: 'human',
      })
      return { handled: true, response: result.message }
    }

    case 'reset': {
      const name = args.trim().toLowerCase()
      if (!name) {
        clearSession(compositeId)
        return { handled: true, response: 'Main session cleared.' }
      }
      const currentProject = getProject(projectId)
      const soul = getSoul(name, currentProject?.slug)
      if (!soul) {
        return { handled: true, response: `Unknown agent "${name}". Use /agents to see available agents.` }
      }
      clearSession(compositeId, soul.id)
      return { handled: true, response: `${soul.emoji} ${soul.name} session cleared.` }
    }

    case 'agents': {
      const currentProjectId = getChatProject(compositeId, chatId)
      const currentProject = getProject(currentProjectId)
      const souls = getAllSouls(currentProject?.slug)
      if (souls.length === 0) {
        return { handled: true, response: 'No agents loaded.' }
      }
      const lines = souls.map((s) =>
        `${s.emoji} ${s.name} (/${s.id}) -- ${s.role} [${s.mode}]`,
      )
      return { handled: true, response: lines.join('\n') }
    }

    case 'switch': {
      const input = args.trim().toLowerCase()
      if (!input) {
        const currentProjectId = getChatProject(compositeId, chatId)
        const current = getProject(currentProjectId)
        const all = listProjects()
        const lines = all.map((p) => {
          const marker = p.id === currentProjectId ? ' (active)' : ''
          return `${p.icon ?? '📁'} ${p.display_name}${marker}`
        })
        return {
          handled: true,
          response: `Current: ${current?.icon ?? '📁'} ${current?.display_name ?? 'Unknown'}\n\nAvailable projects:\n${lines.join('\n')}`,
        }
      }
      const project = getProjectByName(input) ?? getProjectBySlug(input)
      if (!project) {
        return { handled: true, response: `No project found matching "${input}". Use /switch to see available projects.` }
      }
      setChatProject(compositeId, project.id)
      return {
        handled: true,
        response: `${project.icon ?? '📁'} Switched to ${project.display_name}`,
      }
    }

    case 'voice': {
      const { tts } = voiceCapabilities()
      if (!tts) {
        return { handled: true, response: 'Voice replies not available (TTS not configured)' }
      }
      const on = toggleVoiceMode(compositeId)
      return { handled: true, response: `Voice replies ${on ? 'ON' : 'OFF'}` }
    }

    case 'schedule': {
      const currentProjectId = getChatProject(compositeId, chatId)
      const tasks = listTasks(chatId, currentProjectId)
      if (tasks.length === 0) {
        return { handled: true, response: 'No scheduled tasks.' }
      }
      const lines = tasks.map((t) => {
        const status = t.status === 'active' ? '\u2705' : '\u23f8'
        const next = new Date(t.next_run).toLocaleString()
        return `${status} ${t.id}\n   ${t.prompt.slice(0, 60)}${t.prompt.length > 60 ? '...' : ''}\n   Cron: ${t.schedule} | Next: ${next}`
      })
      return { handled: true, response: lines.join('\n\n') }
    }

    case 'status': {
      const session = getSession(compositeId)
      const { stt, tts } = voiceCapabilities()
      const voiceOn = isVoiceMode(compositeId)
      return {
        handled: true,
        response:
          `ClaudePaw Status\n` +
          `Channel: ${channelId}\n` +
          `Session: ${session ? 'active' : 'none'}\n` +
          `STT: ${stt ? 'available' : 'offline'}\n` +
          `TTS: ${tts ? 'available' : 'offline'}\n` +
          `Voice mode: ${voiceOn ? 'ON' : 'OFF'}`,
      }
    }

    case 'plugins': {
      const all = listPlugins()
      if (all.length === 0) {
        return { handled: true, response: 'No plugins installed.' }
      }
      const lines = all.map((p) => {
        const status = p.enabled ? '\u2705' : '\u274c'
        const agent = p.manifest.agent_id ? ` [agent: ${p.manifest.agent_id}]` : ''
        return `${status} ${p.manifest.name} v${p.manifest.version}${agent}\n   ${p.manifest.description}`
      })
      return { handled: true, response: `Plugins (${all.length}):\n\n${lines.join('\n\n')}` }
    }

    default:
      return { handled: false }
  }
}

// ---------------------------------------------------------------------------
// Hot context loader
// ---------------------------------------------------------------------------

/** Load hot context from projects/<slug>/context.md — always injected. */
export function loadHotContext(projectSlug: string | null): string {
  if (!projectSlug) return ''
  try {
    const contextPath = join(PROJECT_ROOT, 'projects', projectSlug, 'context.md')
    if (!existsSync(contextPath)) return ''
    const content = readFileSync(contextPath, 'utf8').trim()
    return content ? `[Project context]\n${content}` : ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Main message processing pipeline
// ---------------------------------------------------------------------------

export async function processMessage(
  msg: IncomingMessage,
  channel: Channel,
  preRoutedAgentId?: string,
): Promise<void> {
  const compositeId = `${msg.channelId}:${msg.chatId}`
  logger.info({ compositeId, source: msg.source, projectId: msg.projectId }, 'processMessage start')

  // Rate limit check
  if (!checkRateLimit(compositeId)) {
    logger.warn({ compositeId }, 'Rate limit exceeded')
    reportFeedItem('guard', 'Rate limited', compositeId)
    await channel.send(msg.chatId, 'Rate limit exceeded. Try again in a minute.')
    return
  }

  // Resolve active project for this chat
  const projectId = msg.projectId ?? getChatProject(compositeId, msg.chatId)
  const projectRecord = getProject(projectId)
  const projectSlug = projectRecord?.slug ?? 'default'

  // Log inbound message
  const isGroupChat = msg.chatId.startsWith('-')
  const inboundEntry = {
    direction: 'in' as const,
    channel: msg.channelId,
    channelName: channelDisplayName(msg.channelId),
    botName: CHANNEL_BOT_NAMES[msg.channelId] ?? msg.channelId,
    projectId,
    chatId: msg.chatId,
    senderName: msg.chatId,
    content: msg.text,
    contentType: msg.mediaType ?? (msg.isVoice ? 'voice' : 'text'),
    isVoice: msg.isVoice,
    isGroup: isGroupChat,
  }
  logChannelMessage(inboundEntry)
  reportChannelLog(inboundEntry as unknown as Record<string, unknown>)

  // Guard: Pre-process (L1-L4) before anything else
  let guardResult: Awaited<ReturnType<typeof guardChain.preProcess>> | null = null
  let guardHarden = false
  try {
    guardResult = await guardChain.preProcess(msg.text, compositeId)

    if (!guardResult.allowed) {
      logger.warn({
        requestId: guardResult.requestId,
        layers: guardResult.triggeredLayers,
        reason: guardResult.blockReason,
      }, 'Guard blocked message')
      reportFeedItem('guard', 'Message BLOCKED', guardResult.blockReason ?? 'Unknown')
      fireGuardBlocked({
        chat_id: compositeId,
        triggered_layers: guardResult.triggeredLayers,
        block_reason: guardResult.blockReason,
        phase: 'pre',
      }, projectId)
      await channel.send(msg.chatId, GUARD_CONFIG.fallbackResponse)
      return
    }

    if (guardResult.flagged) {
      logger.warn({
        requestId: guardResult.requestId,
        layers: guardResult.triggeredLayers,
      }, 'Guard flagged message (processing anyway)')
      reportFeedItem('guard', 'Message FLAGGED', `Layers: ${guardResult.triggeredLayers.join(', ')}`)
    }

    guardHarden = true
  } catch (err) {
    logger.error({ err }, 'Guard pre-process failed, continuing without guard')
  }

  // Use sanitized text from guard if available
  const guardedText = guardResult?.sanitizedText ?? msg.text

  // 0. Route to agent (if not pre-routed)
  let agentId: string | null = preRoutedAgentId ?? msg.agentId ?? null
  let messageText = guardedText
  if (!agentId) {
    try {
      logger.info({ projectSlug, projectId }, 'processMessage: routing message')
      const route = await routeMessage(guardedText, projectSlug, projectId)
      agentId = route.agentId
      messageText = route.strippedMessage
      logger.info({ agentId, confidence: route.confidence }, 'processMessage: routed')
    } catch (err) {
      logger.error({ err }, 'Agent routing failed, falling back to default')
      agentId = null
    }
  }

  // Start telemetry tracker
  const tracker = startRequest(
    msg.chatId,
    msg.source ?? 'telegram',
    msg.text.slice(0, 80),
    msg.text,
    projectId,
  )
  if (agentId) tracker.setAgentId(agentId)

  // 1. Resolve soul + namespaced IDs
  const soul = agentId ? getSoul(agentId, projectSlug) ?? null : null
  const memoryChatId = agentId ? `${compositeId}:${agentId}` : compositeId
  const dashboardAgent = agentId ?? 'system'

  // 2. Report to dashboard
  const msgPreview = msg.text.slice(0, 80)
  reportFeedItem(dashboardAgent, `Message received [${msg.channelId}]`, msgPreview)
  reportAgentStatus(dashboardAgent, 'active', `Processing: ${msgPreview}`)
  reportMetric(msg.channelId, 'messages_received', 1)

  // 3. Build unified agent context (Memory V2)
  let message = messageText
  let historyFallback: Array<{ role: 'user' | 'assistant'; content: string }> = []
  try {
    const { MEMORY_V2_ENABLED } = await import('./config.js')
    if (MEMORY_V2_ENABLED) {
      const { buildAgentContext } = await import('./context/build-agent-context.js')
      const ctx = await buildAgentContext({
        chatId: memoryChatId,
        userId: msg.channelId,
        projectId: projectId ?? 'default',
        agentId: agentId ?? null,
        userMessage: messageText,
        channel: msg.channelId.split(':')[0] ?? 'unknown',
      })
      const contextJoined = ctx.contextBlocks.filter(Boolean).join('\n\n')
      const hotCtx = loadHotContext(projectSlug ?? null)
      const parts = [hotCtx, contextJoined].filter(Boolean)
      if (parts.length > 0) message = `${parts.join('\n\n')}\n\n${messageText}`
      historyFallback = ctx.historyFallback
    } else {
      const memCtx = await buildMemoryContext(memoryChatId, messageText, projectId ?? null)
      const hotCtx = loadHotContext(projectSlug ?? null)
      const parts = [hotCtx, memCtx].filter(Boolean)
      if (parts.length > 0) message = `${parts.join('\n\n')}\n\n${messageText}`
    }
  } catch (err) {
    logger.error({ err }, 'memory-v2 context build failed, falling back to legacy')
    const memCtx = await buildMemoryContext(memoryChatId, messageText, projectId ?? null)
    const hotCtx = loadHotContext(projectSlug ?? null)
    const parts = [hotCtx, memCtx].filter(Boolean)
    if (parts.length > 0) message = `${parts.join('\n\n')}\n\n${messageText}`
  }
  tracker.markMemoryInjected()

  // 3b. Inject project context for project-specific channels
  if (projectId && projectRecord) {
    const projectCtx = buildProjectContext(projectRecord, projectSlug)
    message = `${projectCtx}\n\n${message}`
  }

  // 4. Prepend agent system prompt if soul exists
  if (soul) {
    message = `${buildAgentPrompt(soul, projectId)}\n\n---\n\n${message}`
  }

  // 5. Get existing session (namespaced)
  const existingSession = getSession(compositeId, agentId ?? undefined)
  const sessionId = existingSession?.session_id

  // 6. Start typing indicator
  let typingInterval: ReturnType<typeof setInterval> | undefined
  if (channel.capabilities().typing) {
    const sendTyping = async () => {
      try {
        await channel.sendTyping(msg.chatId)
      } catch { /* ignore typing errors */ }
    }
    await sendTyping()
    typingInterval = setInterval(sendTyping, TYPING_REFRESH_MS)
  }

  try {
    // 7. Run Claude
    tracker.markAgentStarted()
    const {
      text: responseText,
      newSessionId,
      canary,
      delimiterID,
      requestedProvider,
      executedProvider,
      providerFallbackApplied,
      emptyReason,
    } = await runAgent(
      message,
      sessionId,
      () => { /* typing handled by interval above */ },
      guardHarden,
      (event) => tracker.recordSdkEvent(event),
      { projectId: projectId || 'default', source: 'chat' },
      { projectId: projectId || 'default', projectSlug, agentId: soul?.id ?? agentId ?? undefined },
    )
    tracker.markAgentEnded()
    tracker.setExecutionMeta({ requestedProvider, executedProvider, providerFallbackApplied })

    // 8. Clear typing
    if (typingInterval) clearInterval(typingInterval)
    typingInterval = undefined

    // 9. Save session (namespaced)
    if (newSessionId) {
      setSession(compositeId, newSessionId, agentId ?? undefined)
      logger.debug({ compositeId, newSessionId }, 'session persisted')
    } else {
      logger.warn({ compositeId, executedProvider }, 'no session id returned, Layer 5 will reconstruct next turn')
    }

    if (!responseText) {
      await channel.send(msg.chatId, `Agent finished with no output: ${emptyReason ?? 'unknown reason'}`)
      return
    }

    // Record agent response for telemetry
    tracker.setResultText(responseText)

    // Extract and log any research findings from agent output
    extractAndLogFindings(responseText, dashboardAgent, projectId).catch((err) => {
      logger.warn({ err }, 'Research finding extraction failed')
    })

    // Guard: Post-process (L6-L7) -- validate agent output
    if (guardResult) {
      try {
        const postResult = await guardChain.postProcess(
          responseText,
          guardedText,
          {
            requestId: guardResult.requestId,
            canary: canary ?? '',
            delimiterID: delimiterID ?? '',
            chatId: msg.chatId,
          },
        )

        if (postResult.blocked) {
          logger.warn({
            requestId: guardResult.requestId,
            layers: postResult.triggeredLayers,
            reason: postResult.blockReason,
          }, 'Guard blocked response')
          reportFeedItem('guard', 'Response BLOCKED', postResult.blockReason ?? 'Unknown')
          fireGuardBlocked({
            chat_id: compositeId,
            triggered_layers: postResult.triggeredLayers,
            block_reason: postResult.blockReason,
            phase: 'post',
          }, projectId)
          await channel.send(msg.chatId, GUARD_CONFIG.fallbackResponse)
          return
        }
      } catch (err) {
        logger.error({ err }, 'Guard post-process failed, sending response anyway')
      }
    }

    // 10. Save memory
    try {
      const { saveChatMessage } = await import('./chat/messages.js')
      const { runHeuristicExtraction } = await import('./extraction/heuristic.js')
      const { runRealtimeExtraction, isExplicitRememberSignal } = await import('./extraction/realtime.js')
      const { MEMORY_V2_ENABLED, MEMORY_V2_EXTRACT_INLINE } = await import('./config.js')

      if (MEMORY_V2_ENABLED) {
        const userMsgId = saveChatMessage({
          chatId: memoryChatId, projectId: projectId ?? 'default',
          userId: msg.channelId, role: 'user', content: msg.text,
        })
        const asstMsgId = saveChatMessage({
          chatId: memoryChatId, projectId: projectId ?? 'default',
          userId: msg.channelId, role: 'assistant', content: responseText,
        })
        if (MEMORY_V2_EXTRACT_INLINE) {
          runHeuristicExtraction({ chatMessageId: userMsgId, projectId: projectId ?? 'default', userId: msg.channelId, content: msg.text, role: 'user' })
          runHeuristicExtraction({ chatMessageId: asstMsgId, projectId: projectId ?? 'default', userId: msg.channelId, content: responseText, role: 'assistant' })
        }
        if (isExplicitRememberSignal(msg.text)) {
          runRealtimeExtraction({ content: msg.text, projectId: projectId ?? 'default' }).catch(err => logger.warn({ err }, 'realtime extract failed'))
        }
      } else {
        await saveConversationTurn(memoryChatId, msg.text, responseText)
      }
    } catch (err) {
      logger.warn({ err }, 'memory-v2 persist failed')
      await saveConversationTurn(memoryChatId, msg.text, responseText).catch(() => {})
    }

    // Layer 4 extraction — async, fire-and-forget, never blocks response
    void import('./extraction.js')
      .then(({ extractFromConversation }) =>
        extractFromConversation(messageText, responseText, projectId ?? null).catch(() => {}),
      )
      .catch(() => {})

    // 11. Add agent attribution if soul exists
    let replyText = responseText
    if (soul) {
      replyText = `${soul.emoji} ${soul.name}:\n${responseText}`
    }

    // 12. Voice reply or text reply
    const { tts } = voiceCapabilities()
    const channelSupportsVoice = channel.capabilities().voice
    const shouldVoice = tts && channelSupportsVoice && (msg.isVoice || isVoiceMode(compositeId))

    if (shouldVoice) {
      try {
        const audioBuffer = await synthesizeSpeech(responseText.slice(0, 2000))
        await channel.sendVoice(msg.chatId, audioBuffer, replyText)
      } catch (err) {
        logger.error({ err }, 'TTS failed, falling back to text')
        await sendTextReply(channel, msg.chatId, replyText)
      }
    } else {
      await sendTextReply(channel, msg.chatId, replyText)
    }
    tracker.markResponseSent()

    // Log outbound message
    const outboundEntry = {
      direction: 'out' as const,
      channel: msg.channelId,
      channelName: channelDisplayName(msg.channelId),
      botName: CHANNEL_BOT_NAMES[msg.channelId] ?? msg.channelId,
      projectId,
      chatId: msg.chatId,
      agentId: agentId ?? undefined,
      content: responseText,
    }
    logChannelMessage(outboundEntry)
    reportChannelLog(outboundEntry as unknown as Record<string, unknown>)

    // 13. Report completion
    reportAgentStatus(dashboardAgent, 'idle')
    reportFeedItem(dashboardAgent, 'Response sent', `${responseText.length} chars [${msg.channelId}]`)
    reportMetric(msg.channelId, 'messages_sent', 1)
    fireAgentCompleted({
      agent_id: dashboardAgent,
      task_preview: msg.text.slice(0, 200),
      result_preview: responseText.slice(0, 500),
      source: msg.channelId,
    }, projectId)
  } catch (err) {
    const failureMeta = extractExecutionFailureMeta(err)
    const failureSummary = buildFailureSummary(err, failureMeta)
    // Capture provider info in telemetry even on total failure so we know which
    // provider was attempted and whether a fallback was in progress.
    if (failureMeta.requestedProvider || failureMeta.attemptedProvider) {
      tracker.setExecutionMeta({
        requestedProvider: failureMeta.requestedProvider,
        executedProvider: failureMeta.attemptedProvider,
        providerFallbackApplied: failureMeta.providerFallbackApplied,
      })
    }
    const failureEntry = {
      direction: 'out' as const,
      channel: msg.channelId,
      channelName: channelDisplayName(msg.channelId),
      botName: CHANNEL_BOT_NAMES[msg.channelId] ?? msg.channelId,
      projectId,
      chatId: msg.chatId,
      agentId: agentId ?? undefined,
      content: failureSummary,
      error: err instanceof Error ? err.message : String(err),
    }
    logChannelMessage(failureEntry)
    reportChannelLog(failureEntry as unknown as Record<string, unknown>)
    logger.error({ err }, 'processMessage failed')
    reportAgentStatus(dashboardAgent, 'error', 'Message handling failed')
    reportFeedItem(dashboardAgent, 'Error', failureSummary)
    await channel.send(msg.chatId, 'Something went wrong running that command. Check the logs.').catch(() => {})
  } finally {
    if (typingInterval) clearInterval(typingInterval)
    try {
      tracker.finalize()
    } catch (err) {
      logger.error({ err }, 'Telemetry finalize failed')
    }
    // Sync event to Hostinger DB so GET /chat returns full history (fire-and-forget)
    try {
      const row = tracker.toEventRow()
      fetch(`${DASHBOARD_BASE_URL}/api/v1/chat/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(BOT_API_TOKEN ? { 'x-dashboard-token': BOT_API_TOKEN } : {}),
        },
        body: JSON.stringify(row),
      }).catch((err) => {
        logger.warn({ err }, 'Event sync to Hostinger failed (non-fatal)')
      })
    } catch (err) {
      logger.warn({ err }, 'Failed to build event row for sync (non-fatal)')
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sendTextReply(channel: Channel, chatId: string, text: string): Promise<void> {
  const formatter = getFormatter(channel.id)
  const formatted = formatter(text)
  const chunks = splitMessage(formatted, channel.capabilities().maxMessageLength)
  for (const chunk of chunks) {
    await channel.send(chatId, chunk)
  }
}
