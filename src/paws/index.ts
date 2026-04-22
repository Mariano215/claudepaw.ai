// src/paws/index.ts
import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { computeNextRun } from '../scheduler.js'
import * as pawsDb from './db.js'
import { runPawCycle, resumePawCycle } from './engine.js'
import type { Paw, PawConfig, PawCycle, ApprovalSender, PawSender } from './types.js'

type Sender = (chatId: string, text: string) => Promise<void>

export type { Paw, PawConfig, PawCycle, PawPhase, PawStatus } from './types.js'

// Phase 5 Task 5: weekly regime model retrain Paw. Declarative config so
// seed + tests + docs all reference the same source of truth. The seed
// script pushes this into the `paws` table; tests pin the invariants.

export function createPaw(input: {
  id: string
  project_id: string
  name: string
  agent_id: string
  cron: string
  config: PawConfig
}): Paw {
  const db = getDb()
  pawsDb.createPaw(db, input)
  const nextRun = computeNextRun(input.cron)
  pawsDb.updatePawNextRun(db, input.id, nextRun)
  return pawsDb.getPaw(db, input.id)!
}

export function getPaw(id: string): Paw | undefined {
  return pawsDb.getPaw(getDb(), id)
}

export function listPaws(projectId?: string): Paw[] {
  return pawsDb.listPaws(getDb(), projectId)
}

export function pausePaw(id: string): void {
  pawsDb.updatePawStatus(getDb(), id, 'paused')
}

export function resumePaw(id: string): void {
  pawsDb.updatePawStatus(getDb(), id, 'active')
}

export function deletePaw(id: string): void {
  pawsDb.deletePaw(getDb(), id)
}

export function getPawCycles(pawId: string, limit = 20): PawCycle[] {
  return pawsDb.listCycles(getDb(), pawId, limit)
}

export function getLatestCycle(pawId: string): PawCycle | undefined {
  return pawsDb.getLatestCycle(getDb(), pawId)
}

export function getDuePaws(): Paw[] {
  return pawsDb.getDuePaws(getDb())
}

export async function triggerPaw(
  pawId: string,
  runAgent: (prompt: string) => Promise<{ text: string | null; emptyReason?: string; resultSubtype?: string }>,
  send: Sender,
  sendApproval?: ApprovalSender,
  pawSend?: PawSender,
): Promise<string> {
  const db = getDb()
  const paw = pawsDb.getPaw(db, pawId)
  if (!paw) throw new Error(`Paw not found: ${pawId}`)

  const nextRun = computeNextRun(paw.cron)

  // Advance next_run BEFORE running the cycle so that a crash mid-cycle does
  // not leave the Paw marked immediately-due. Scheduled tasks do the same
  // (src/scheduler.ts advances before running). Combined with the startup
  // orphan-cycle reaper in clearStalePawCycles(), this prevents double-fires
  // after bot restarts interrupting long-running phases (e.g. a retrain Paw
  // that SSHes to a remote host and takes several minutes).
  pawsDb.updatePawNextRun(db, pawId, nextRun)
  logger.info({ pawId, nextRun }, 'Triggering paw cycle')
  return await runPawCycle(db, pawId, runAgent, send, sendApproval, pawSend)
}

export async function handleApproval(
  pawId: string,
  approved: boolean,
  runAgent: (prompt: string) => Promise<{ text: string | null; emptyReason?: string; resultSubtype?: string }>,
  send: Sender,
  pawSend?: PawSender,
): Promise<void> {
  const db = getDb()
  const cycle = pawsDb.getLatestCycle(db, pawId)
  if (!cycle) throw new Error(`No cycles found for paw: ${pawId}`)
  if (cycle.phase !== 'decide' || !cycle.state.approval_requested) {
    throw new Error(`Paw ${pawId} is not waiting for approval`)
  }

  await resumePawCycle(db, cycle.id, approved, runAgent, send, pawSend)
}

/**
 * Self-contained approval processor. Builds its own agentRunner from the paw's
 * agent config. Both Telegram callbacks and dashboard handlers call this.
 */
export async function processPawApproval(
  pawId: string,
  approved: boolean,
  send: Sender,
  pawSend?: PawSender,
): Promise<void> {
  const paw = getPaw(pawId)
  if (!paw) throw new Error(`Paw not found: ${pawId}`)

  const { runAgent } = await import('../agent.js')
  const { getSoul, buildAgentPrompt } = await import('../souls.js')

  const agentRunner = async (prompt: string): Promise<{ text: string | null; emptyReason?: string; resultSubtype?: string }> => {
    const soul = paw.agent_id ? getSoul(paw.agent_id) : undefined
    let fullPrompt = prompt
    if (soul) {
      fullPrompt = `${buildAgentPrompt(soul, paw.project_id)}\n\n---\n\n${prompt}`
    }
    const { text, emptyReason, resultSubtype } = await runAgent(fullPrompt, undefined, undefined, undefined, undefined, {
      projectId: paw.project_id,
      source: paw.agent_id ?? 'paw',
    }, {
      projectId: paw.project_id,
      agentId: paw.agent_id ?? 'paw',
    })
    return { text, emptyReason, resultSubtype }
  }

  await handleApproval(pawId, approved, agentRunner, send, pawSend)
}
