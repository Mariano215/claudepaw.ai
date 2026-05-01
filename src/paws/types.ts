// src/paws/types.ts

export type PawPhase = 'observe' | 'analyze' | 'decide' | 'act' | 'report'
export type PawStatus = 'active' | 'paused' | 'waiting_approval'

export const PAW_PHASES: PawPhase[] = ['observe', 'analyze', 'decide', 'act', 'report']

export interface Paw {
  id: string
  project_id: string
  name: string
  agent_id: string
  cron: string
  status: PawStatus
  config: PawConfig
  next_run: number
  created_at: number
}

export interface PawConfig {
  approval_threshold: number
  chat_id: string
  approval_timeout_sec: number
  phase_instructions?: Partial<Record<PawPhase, string>>
  /**
   * Optional named collector that runs BEFORE the OBSERVE LLM call.
   * Collectors are deterministic TypeScript functions registered in
   * `src/paws/collectors/index.ts`. They gather raw data (gh, fetch,
   * DB queries, etc.) and return structured JSON. The engine stuffs
   * that JSON into the OBSERVE prompt so the agent never has to call
   * tools to gather -- it only analyzes. This insulates paws from the
   * current execution provider's tool-use capabilities.
   */
  observe_collector?: string
  /**
   * Optional arguments passed to the collector at runtime (JSON-serialized).
   */
  observe_collector_args?: Record<string, unknown>
}

export interface PawCycle {
  id: string
  paw_id: string
  started_at: number
  phase: PawPhase | 'completed' | 'failed'
  state: PawCycleState
  findings: PawFinding[]
  actions_taken: string[]
  report: string | null
  completed_at: number | null
  error: string | null
}

export interface PawCycleState {
  observe_raw: string | null
  analysis: string | null
  decisions: PawDecision[] | null
  approval_requested: boolean
  approval_granted: boolean | null
  act_result: string | null
}

export interface PawFinding {
  id: string
  severity: number
  title: string
  detail: string
  is_new: boolean
  evidence_urls?: string[]
}

export interface PawDecision {
  finding_id: string
  action: 'act' | 'skip' | 'escalate'
  reason: string
}

/**
 * Sends an approval request with inline action buttons (e.g. Telegram inline keyboard).
 * Falls back to plain text if the channel doesn't support buttons.
 */
export type ApprovalSender = (chatId: string, text: string, pawId: string, projectId?: string) => Promise<void>

/** Inline keyboard payload matching the grammy / Telegram Bot API shape. */
export interface InlineKeyboardButton {
  text: string
  callback_data: string
}

export interface InlineKeyboard {
  inline_keyboard: InlineKeyboardButton[][]
}

/**
 * Paw-scoped sender. Like `Sender` but accepts an optional inline keyboard.
 * When the underlying channel does not support keyboards, the implementation
 * silently ignores the third argument.
 */
export type PawSender = (chatId: string, text: string, keyboard?: InlineKeyboard, projectId?: string) => Promise<void>
