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
  /**
   * Optional named handler that runs AFTER the ACT LLM call.
   * Handlers are deterministic TypeScript functions registered in
   * `src/paws/handlers/index.ts`. They receive the cycle ID and the
   * raw ACT phase text output, parse structured JSON from it, and
   * perform the actual side-effects (DB inserts, notify.sh calls, emails).
   *
   * This solves the ACT-phase hallucination problem: agents running on
   * non-claude_desktop providers have no real tool access, so telling them
   * to run Bash/SQLite in ACT instructions produces plausible-sounding but
   * fake output. Handlers move deterministic work to TypeScript where it
   * actually executes.
   */
  post_act_handler?: string
  /**
   * Optional named handler that runs AFTER the ANALYZE LLM call and BEFORE
   * DECIDE. Same registry and signature as post_act_handler; it receives the
   * raw ANALYZE text. Paw Dev uses it to open cards from triage findings so a
   * cycle that parks at DECIDE has already recorded what it saw.
   */
  post_analyze_handler?: string
  /**
   * When true and a collector is configured, the engine skips ANALYZE/DECIDE/
   * ACT/REPORT entirely if the collector's raw_data is unchanged since the
   * previous cycle. Keeps quiet routines (nothing new to report) from
   * spending an LLM call every scheduled run.
   */
  skip_if_unchanged?: boolean
  /**
   * When true, ACT and the post-ACT handler run even on a quiet cycle. For a
   * routine whose handler drains a queue (Paw Dev's builder), a cycle with no
   * new findings still has work to do.
   */
  always_run_act?: boolean
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
  approval_requested_at?: number | null
  approval_granted: boolean | null
  act_result: string | null
  /** JSON.stringify(collector raw_data) from this cycle, used by skip_if_unchanged. */
  observe_fingerprint?: string
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
