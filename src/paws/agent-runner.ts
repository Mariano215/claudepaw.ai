// src/paws/agent-runner.ts
//
// One place that builds the function a routine (Paw) cycle uses to call the
// model. It existed in three near-identical copies: the scheduler's due-paw
// loop, processPawApproval, and the dashboard's run-now handler. They drifted,
// and the drift was the bug: none of them recorded telemetry, and two of them
// resolved the agent without its project so the agent had no persona at all.
//
// What it guarantees for every routine run, however it was started:
//   - the agent is resolved with its project, so a project-scoped agent and a
//     composite `<slug>--<template>` id both work
//   - one agent_events row per ODAR phase, mirrored to the dashboard, so routine
//     cost, provider and duration are attributable
//   - the run is tagged with the project for the cost gate

import { logger } from '../logger.js'
import { startRequest } from '../telemetry.js'
import { postEventToServer } from '../event-sync.js'
import type { Paw, PawPhase } from './types.js'

export interface PawAgentRunResult {
  text: string | null
  emptyReason?: string
  resultSubtype?: string
}

export type PawAgentRunner = (prompt: string, phase?: PawPhase) => Promise<PawAgentRunResult>

export function makePawAgentRunner(paw: Paw): PawAgentRunner {
  return async (prompt: string, phase?: PawPhase): Promise<PawAgentRunResult> => {
    const { runAgent } = await import('../agent.js')
    const { getSoul, buildAgentPrompt } = await import('../souls.js')

    const agentId = paw.agent_id ?? 'paw'
    const projectId = paw.project_id ?? 'default'

    // Pass the project. Without it a project-scoped agent resolves to nothing,
    // buildAgentPrompt never runs, and the action-plan instructions that feed
    // parseActionItemsFromAgentOutput never reach the model.
    const soul = paw.agent_id ? getSoul(paw.agent_id, projectId) : undefined
    const fullPrompt = soul
      ? `${buildAgentPrompt(soul, projectId)}\n\n---\n\n${prompt}`
      : prompt

    const tracker = startRequest(
      paw.config?.chat_id ?? '',
      'scheduler',
      `paw ${paw.id}${phase ? ` ${phase}` : ''}`,
      fullPrompt,
      projectId,
    )
    tracker.setAgentId(agentId)
    tracker.markAgentStarted()

    try {
      const res = await runAgent(fullPrompt, undefined, undefined, undefined,
        (event) => tracker.recordSdkEvent(event),
        { projectId, source: agentId },
        { projectId, agentId },
      )
      tracker.setExecutionMeta({
        requestedProvider: res.requestedProvider,
        executedProvider: res.executedProvider,
        providerFallbackApplied: res.providerFallbackApplied,
      })
      if (res.text) tracker.setResultText(res.text)
      return { text: res.text, emptyReason: res.emptyReason, resultSubtype: res.resultSubtype }
    } finally {
      // Write the local row, then mirror it to the dashboard. Both non-fatal:
      // losing telemetry must never fail a cycle.
      try {
        tracker.markAgentEnded()
        tracker.finalize()
      } catch (err) {
        logger.warn({ err, pawId: paw.id }, 'Paw telemetry finalize failed (non-fatal)')
      }
      try {
        postEventToServer(tracker.toEventRow()).catch((err: unknown) => {
          logger.warn({ err, pawId: paw.id }, 'Paw telemetry sync failed (non-fatal)')
        })
      } catch (err) {
        logger.warn({ err, pawId: paw.id }, 'Paw telemetry sync setup failed (non-fatal)')
      }
    }
  }
}
