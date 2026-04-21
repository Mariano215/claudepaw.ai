// src/paws/engine.ts
import type Database from 'better-sqlite3'
import type { Paw, PawPhase, PawCycleState, PawFinding, PawDecision, PawCycle, ApprovalSender, PawSender } from './types.js'
import { buildApprovalCard, type ApprovalFinding } from './approval-card.js'
import { getProjectName } from './project-name.js'
import { getPaw, createCycle, updateCycle, getCycle, updatePawStatus } from './db.js'
import { runCollector } from './collectors/index.js'
import { guardChain } from '../guard/index.js'
import { logger } from '../logger.js'
import { extractAndLogFindings } from '../research.js'

type AgentRunner = (prompt: string) => Promise<{ text: string | null }>
type Sender = (chatId: string, text: string) => Promise<void>

/**
 * Run a single Paw cycle through all phases.
 * Returns the cycle ID.
 */
export async function runPawCycle(
  db: InstanceType<typeof Database>,
  pawId: string,
  runAgent: AgentRunner,
  send: Sender,
  sendApproval?: ApprovalSender,
  pawSend?: PawSender,
): Promise<string> {
  const paw = getPaw(db, pawId)
  if (!paw) throw new Error(`Paw not found: ${pawId}`)

  const cycleId = createCycle(db, pawId)

  try {
    const previousCycle = getLatestCycleBefore(db, pawId, cycleId)

    // OBSERVE
    // If the paw declares a collector, use deterministic TS code to gather raw
    // data. Otherwise fall back to an LLM-driven observe (legacy path). The
    // collector path is preferred: zero LLM cost, cannot hallucinate, and works
    // on every execution provider.
    let observeResult: string
    const collectorName = paw.config.observe_collector
    if (collectorName) {
      const collected = await runCollector(collectorName, {
        pawId,
        projectId: paw.project_id,
        args: paw.config.observe_collector_args,
      })
      // Serialize into the string shape the rest of the pipeline expects.
      // `observe_raw` is stored as a string and later substituted into the
      // ANALYZE prompt, so JSON stringify keeps downstream code unchanged.
      observeResult = JSON.stringify(collected, null, 2)
      logger.info(
        { pawId, collector: collectorName, errorCount: collected.errors?.length ?? 0 },
        '[paws] OBSERVE via collector',
      )
    } else {
      observeResult = await runPhase(paw, 'observe', {
        previousFindings: previousCycle?.findings ?? [],
        previousState: previousCycle?.state ?? null,
      }, runAgent)

      // Extract research findings from the observe output (free-form text).
      // Only relevant on the LLM path -- collector output is structured JSON.
      extractAndLogFindings(observeResult, paw.agent_id, paw.project_id).catch(err =>
        logger.warn({ err, pawId }, '[paws] Research extraction failed (observe)')
      )
    }

    const state: PawCycleState = {
      observe_raw: observeResult,
      analysis: null,
      decisions: null,
      approval_requested: false,
      approval_granted: null,
      act_result: null,
    }
    updateCycle(db, cycleId, { phase: 'analyze', state })

    // ANALYZE
    const analyzeResult = await runPhase(paw, 'analyze', {
      observe_raw: observeResult,
      previousFindings: previousCycle?.findings ?? [],
    }, runAgent)

    let findings: PawFinding[] = []
    try {
      // Agent may wrap JSON in markdown code fences -- strip them before parsing
      const cleaned = analyzeResult.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
      const parsed = JSON.parse(cleaned)
      findings = parsed.findings ?? []
    } catch {
      // Extract a useful title from the first sentence of the agent's response
      const firstLine = analyzeResult.split(/[.\n]/).filter(s => s.trim().length > 5)[0]?.trim() ?? 'Analysis complete'
      const title = firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine
      findings = [{
        id: 'unstructured',
        severity: 2,
        title,
        detail: analyzeResult,
        is_new: true,
      }]
    }

    state.analysis = analyzeResult
    updateCycle(db, cycleId, { phase: 'decide', state, findings })

    // DECIDE
    const decideResult = await runPhase(paw, 'decide', {
      findings,
      analysis: analyzeResult,
    }, runAgent)

    let decisions: PawDecision[] = []
    let maxSeverity = 0
    try {
      const parsed = JSON.parse(decideResult)
      decisions = parsed.decisions ?? []
      maxSeverity = parsed.max_severity ?? Math.max(0, ...findings.map(f => f.severity))
    } catch {
      maxSeverity = Math.max(0, ...findings.map(f => f.severity))
    }

    state.decisions = decisions
    updateCycle(db, cycleId, { state })

    // Check if approval is needed
    if (maxSeverity >= paw.config.approval_threshold) {
      state.approval_requested = true
      updateCycle(db, cycleId, { state })

      // Mark paw as waiting_approval so the scheduler skips it until resolved
      updatePawStatus(db, pawId, 'waiting_approval')

      // Build plain-English approval message
      const actionFindings = findings.filter(f => f.severity >= paw.config.approval_threshold)
      const projectName = getProjectName(paw.project_id)

      // PawFinding does not carry target / auto_fixable; defaults keep non-security paws
      // working (they render [→ Dashboard] + [Dismiss] with a harmless empty target).
      const cardFindings: ApprovalFinding[] = actionFindings.map(f => ({
        id: f.id,
        title: f.title,
        detail: f.detail,
        severity: f.severity,
        target: (f as unknown as { target?: string }).target ?? '',
        auto_fixable: (f as unknown as { auto_fixable?: 0 | 1 }).auto_fixable ?? 0,
      }))
      const card = buildApprovalCard(paw, projectName, cardFindings, Date.now())

      if (pawSend) {
        await pawSend(paw.config.chat_id, card.text, card.keyboard)
      } else if (sendApproval) {
        await sendApproval(paw.config.chat_id, card.text, pawId)
      } else {
        await send(
          paw.config.chat_id,
          card.text + `\n\nReply "approve ${pawId}" to continue or "skip ${pawId}" to skip.`,
        )
      }

      return cycleId
    }

    // ACT (no approval needed)
    await runActAndReport(db, cycleId, paw, state, findings, decisions, runAgent, send)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    updateCycle(db, cycleId, { phase: 'failed', error: errMsg, completed_at: Date.now() })
    updatePawStatus(db, pawId, 'active')
  }

  return cycleId
}

/**
 * Resume a paused cycle after human approval.
 */
export async function resumePawCycle(
  db: InstanceType<typeof Database>,
  cycleId: string,
  approved: boolean,
  runAgent: AgentRunner,
  send: Sender,
  pawSend?: PawSender,
): Promise<void> {
  const cycle = getCycle(db, cycleId)
  if (!cycle) throw new Error(`Cycle not found: ${cycleId}`)
  if (cycle.phase !== 'decide' || !cycle.state.approval_requested) {
    throw new Error(`Cycle ${cycleId} is not waiting for approval`)
  }

  const paw = getPaw(db, cycle.paw_id)
  if (!paw) throw new Error(`Paw not found: ${cycle.paw_id}`)

  // Restore active status at the start of both paths, inside try block
  try {
    updatePawStatus(db, cycle.paw_id, 'active')
  } catch (err) {
    // If status update fails, still continue with the cycle
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.warn(`[paws] Status reset failed for cycle ${cycleId}: ${errMsg}`)
  }

  const state = { ...cycle.state, approval_granted: approved }
  updateCycle(db, cycleId, { state })

  if (!approved) {
    // Bug 3 fix: REPORT phase failure should not crash the denial path either
    let reportResult: string
    try {
      reportResult = await runPhase(paw, 'report', {
        findings: cycle.findings,
        decisions: state.decisions,
        skipped_act: true,
      }, runAgent)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.warn(`[paws] REPORT phase failed for cycle ${cycleId} (denied): ${errMsg}`)
      reportResult = '[Paw cycle completed -- report generation failed]'
    }

    // Extract research findings even when ACT is skipped
    extractAndLogFindings(reportResult, paw.agent_id, paw.project_id).catch(err =>
      logger.warn({ err, cycleId }, '[paws] Research extraction failed (report, denied)')
    )

    updateCycle(db, cycleId, {
      phase: 'completed',
      report: reportResult,
      completed_at: Date.now(),
      state,
    })
    const projectName = getProjectName(paw.project_id)
    const meta = `paw: ${paw.id}  •  project: ${paw.project_id}  •  cron: ${paw.cron}`
    const header = `🛡 ${paw.name}\n${projectName}  •  ACT skipped\n${meta}\n\n`
    await send(paw.config.chat_id, header + reportResult)
    return
  }

  try {
    await runActAndReport(db, cycleId, paw, state, cycle.findings, state.decisions ?? [], runAgent, send)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    updateCycle(db, cycleId, { phase: 'failed', error: errMsg, completed_at: Date.now() })
    updatePawStatus(db, cycle.paw_id, 'active')
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * True when the cycle has something worth running ACT/REPORT for:
 *   - at least one finding is new (is_new: true), OR
 *   - at least one decision plans to act or escalate.
 *
 * Quiet cycles (no findings, or only known findings with no planned actions)
 * skip ACT and REPORT entirely and complete silently -- no Telegram ping.
 * This prevents the "All clear. Score 100/100, no changes since last scan."
 * noise every 4h from monitoring paws like sentinel-patrol.
 */
function hasMeaningfulWork(findings: PawFinding[], decisions: PawDecision[]): boolean {
  const hasNewFindings = findings.some(f => f.is_new === true)
  const hasPlannedActions = decisions.some(d => d.action === 'act' || d.action === 'escalate')
  return hasNewFindings || hasPlannedActions
}

async function runActAndReport(
  db: InstanceType<typeof Database>,
  cycleId: string,
  paw: Paw,
  state: PawCycleState,
  findings: PawFinding[],
  decisions: PawDecision[],
  runAgent: AgentRunner,
  send: Sender,
): Promise<void> {
  // Quiet cycle short-circuit: nothing new, no planned actions.
  // Mark completed, skip ACT/REPORT/Telegram to cut noise + cost.
  if (!hasMeaningfulWork(findings, decisions)) {
    updateCycle(db, cycleId, {
      phase: 'completed',
      report: null,
      completed_at: Date.now(),
      state,
    })
    logger.debug({ pawId: paw.id, cycleId }, '[paws] Quiet cycle - skipping ACT/REPORT/notify')
    return
  }

  updateCycle(db, cycleId, { phase: 'act' })
  const actResult = await runPhase(paw, 'act', { findings, decisions }, runAgent)

  // Extract research findings from act output
  extractAndLogFindings(actResult, paw.agent_id, paw.project_id).catch(err =>
    logger.warn({ err, cycleId }, '[paws] Research extraction failed (act)')
  )

  state.act_result = actResult
  const actionsTaken = [actResult]
  updateCycle(db, cycleId, { state, actions_taken: actionsTaken })

  updateCycle(db, cycleId, { phase: 'report' })

  // Bug 3 fix: REPORT phase failures should not mark a completed cycle as failed
  let reportResult: string
  try {
    reportResult = await runPhase(paw, 'report', {
      findings,
      decisions,
      act_result: actResult,
    }, runAgent)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    logger.warn(`[paws] REPORT phase failed for cycle ${cycleId}: ${errMsg}`)
    reportResult = '[Paw cycle completed -- report generation failed]'
  }

  // Extract research findings from the report output
  extractAndLogFindings(reportResult, paw.agent_id, paw.project_id).catch(err =>
    logger.warn({ err, cycleId }, '[paws] Research extraction failed (report)')
  )

  updateCycle(db, cycleId, {
    phase: 'completed',
    report: reportResult,
    completed_at: Date.now(),
    state,
  })

  if (reportResult && reportResult.trim().length > 0) {
    const projectName = getProjectName(paw.project_id)
    const meta = `paw: ${paw.id}  •  project: ${paw.project_id}  •  cron: ${paw.cron}`
    const header = `🛡 ${paw.name}\n${projectName}  •  Cycle complete\n${meta}\n\n`
    await send(paw.config.chat_id, header + reportResult)
  }
}

function getLatestCycleBefore(
  db: InstanceType<typeof Database>,
  pawId: string,
  excludeCycleId: string,
): PawCycle | undefined {
  // Only consider completed or explicitly-failed cycles as "previous".
  // Orphaned cycles left in observe/analyze/decide/act/report after a bot
  // crash would otherwise be returned here with empty findings + null raw
  // state and poison the next cycle's ANALYZE/DECIDE context.
  const row = db.prepare(
    `SELECT * FROM paw_cycles
       WHERE paw_id = ?
         AND id != ?
         AND phase IN ('completed', 'failed')
       ORDER BY started_at DESC LIMIT 1`
  ).get(pawId, excludeCycleId) as any
  if (!row) return undefined
  return {
    ...row,
    state: JSON.parse(row.state),
    findings: JSON.parse(row.findings),
    actions_taken: JSON.parse(row.actions_taken),
  }
}

async function runPhase(
  paw: Paw,
  phase: PawPhase,
  context: Record<string, any>,
  runAgent: AgentRunner,
): Promise<string> {
  const customInstructions = paw.config.phase_instructions?.[phase] ?? ''
  const basePrompt = buildPhasePrompt(paw, phase, context, customInstructions)

  // Always apply Guard hardening for Paws phases.  The OBSERVE phase may have
  // fetched tainted content (feeds, API responses, web pages) that could contain
  // prompt-injection payloads.  Hardening every phase prompt ensures the Guard
  // pipeline processes it before the model sees it.
  const hardened = guardChain.hardenPrompt('', basePrompt)
  const prompt = `${hardened.systemPrompt}\n\n${basePrompt}`

  const result = await runAgent(prompt)
  if (!result.text || result.text.trim().length === 0) {
    throw new Error(`Agent returned no text for ${phase} phase`)
  }
  return result.text
}

function buildPhasePrompt(
  paw: Paw,
  phase: PawPhase,
  context: Record<string, any>,
  customInstructions: string,
): string {
  const header = `You are running as a Paws Mode agent in the ${phase.toUpperCase()} phase.\nPaw: ${paw.name}\n\n`

  const phaseInstructions: Record<PawPhase, string> = {
    observe: `OBSERVE PHASE: Gather raw data. Run scans, check APIs, collect information. Output your raw findings as text.\n\nContext from previous cycles:\n${JSON.stringify(context.previousFindings ?? [], null, 2)}`,

    analyze: `ANALYZE PHASE: Review the raw observations below. Compare against previous cycle findings. Identify what's new, what changed, and what's a known issue.

CRITICAL: Your entire response must be a single JSON object. No prose, no explanation, no markdown fences. Just JSON.

Required format:
{"findings": [{"id": "short-kebab-id", "severity": 1, "title": "Plain English summary of what you found", "detail": "Supporting details and context", "is_new": true}]}

Example:
{"findings": [{"id": "linkedin-gap", "severity": 2, "title": "No LinkedIn post in 6 days, usual cadence is every 3-4 days", "detail": "Last post was April 7. Engagement on recent posts averaged 4.2% which is above baseline.", "is_new": true}]}

The "title" field is what the human sees in approval messages. Write it as a clear, specific sentence -- not a label. Say what you found, not what category it falls into.

Severity guide: 1=info, 2=worth noting, 3=should act soon, 4=needs attention now, 5=critical

Raw observations:
${context.observe_raw}`,

    decide: `DECIDE PHASE: Review the findings and decide what action to take for each. Consider severity and whether it's new.\n\nYou MUST respond with valid JSON:\n{"decisions": [{"finding_id": "string", "action": "act|skip|escalate", "reason": "string"}], "max_severity": number}\n\nFindings:\n${JSON.stringify(context.findings, null, 2)}`,

    act: `ACT PHASE: Execute the decided actions. You have full tool access.\n\nDecisions:\n${JSON.stringify(context.decisions, null, 2)}\n\nFindings:\n${JSON.stringify(context.findings, null, 2)}`,

    report: `REPORT PHASE: Write a concise summary for the operator. Only report what matters -- new findings, actions taken, changes from last cycle. Keep it tight.\n\nFindings:\n${JSON.stringify(context.findings, null, 2)}\nDecisions:\n${JSON.stringify(context.decisions, null, 2)}\nActions:\n${context.act_result ?? 'ACT was skipped'}`,
  }

  let prompt = header + phaseInstructions[phase]
  if (customInstructions) {
    prompt += `\n\nAdditional instructions:\n${customInstructions}`
  }
  return prompt
}
