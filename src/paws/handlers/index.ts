// src/paws/handlers/index.ts
//
// Registry of post-ACT handlers for Paw cycles.
//
// Handlers solve the ACT-phase hallucination problem: agents running on
// non-claude_desktop providers have no real tool access.  Telling them to
// run Bash/SQLite commands in the ACT phase instructions produces
// plausible-looking output that is entirely fabricated.  Handlers move
// the deterministic side-effects (DB inserts, notify.sh, email) out of
// the LLM and into TypeScript where they actually run.
//
// How it works:
//   1. The ACT phase instructs the agent to output a structured JSON block
//      describing what should happen (insert_deal, notify, etc.) — no Bash.
//   2. After the ACT phase LLM call completes, the engine calls the named
//      post_act_handler with (cycleId, pawId, projectId, actOutputText).
//   3. The handler parses the JSON from actOutputText and performs the
//      actual side-effects.
//
// Registering a new handler:
//   import the function here and add it to HANDLERS below.

import { brokerPropertyPersistHandler } from './broker-property-persist.js'
import { brokerPocketPersistHandler } from './broker-pocket-persist.js'
import { brokerWeeklyEmailHandler } from './broker-weekly-email.js'
import { logger } from '../../logger.js'

export type PostActHandler = (
  cycleId: string,
  pawId: string,
  projectId: string,
  actOutput: string,
) => Promise<void>

const HANDLERS: Record<string, PostActHandler> = {
  'broker-property-persist': brokerPropertyPersistHandler,
  'broker-pocket-persist': brokerPocketPersistHandler,
  'broker-weekly-email': brokerWeeklyEmailHandler,
}

export function getHandler(name: string): PostActHandler | null {
  const handler = HANDLERS[name]
  if (!handler) {
    logger.warn({ name }, '[paws/handlers] Unknown post_act_handler — skipping')
    return null
  }
  return handler
}

export function registerHandler(name: string, fn: PostActHandler): void {
  HANDLERS[name] = fn
}
