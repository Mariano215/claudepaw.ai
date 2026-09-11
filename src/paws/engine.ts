// src/paws/engine.ts
import type Database from 'better-sqlite3'
import type { Paw, PawPhase, PawCycleState, PawFinding, PawDecision, PawCycle, ApprovalSender, PawSender } from './types.js'
import { buildApprovalCard, type ApprovalFinding } from './approval-card.js'
import { getProjectName } from './project-name.js'
import { getPaw, createCycle, updateCycle, getCycle, updatePawStatus, listCycles } from './db.js'
import { runCollector, type CollectorResult } from './collectors/index.js'
import { getHandler } from './handlers/index.js'
import { guardChain } from '../guard/index.js'
import { logger } from '../logger.js'
import { extractAndLogFindings } from '../research.js'
import { normalizeUrl } from '../newsletter/feeds.js'

type AgentRunResult = {
  text: string | null
  emptyReason?: string
  resultSubtype?: string
  eventCount?: number
  assistantTurns?: number
  toolUses?: number
  durationSec?: number
}

/**
 * Runs one phase prompt.
 *
 * `phase` is optional so existing callers compile unchanged, but the scheduler
 * uses it to label telemetry. Without it, routine runs were invisible in
 * agent_events: the cost, provider and duration of every ODAR phase went
 * unrecorded, so routine spend was unattributed.
 */
type AgentRunner = (prompt: string, phase?: PawPhase) => Promise<AgentRunResult>
type Sender = (chatId: string, text: string, projectId?: string) => Promise<void>
const FINDING_DEDUPE_HISTORY_LIMIT = 10
// A hung collector (network black hole, stuck CLI) must not stall a cycle
// forever. 120s is well above the slowest known collector (the 15s festival
// feed timeout) and short enough that a stuck cycle self-resolves the same day.
const COLLECTOR_TIMEOUT_MS = 120_000

function withCollectorTimeout(
  promise: Promise<CollectorResult>,
  collectorName: string,
): Promise<CollectorResult> {
  return Promise.race([
    promise,
    new Promise<CollectorResult>((resolve) => {
      setTimeout(() => resolve({
        raw_data: null,
        collected_at: Date.now(),
        collector: collectorName,
        errors: ['collector timeout'],
      }), COLLECTOR_TIMEOUT_MS)
    }),
  ])
}

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
    let observeFingerprint: string | undefined
    const collectorName = paw.config.observe_collector
    if (collectorName) {
      const collected = await withCollectorTimeout(runCollector(collectorName, {
        pawId,
        projectId: paw.project_id,
        args: paw.config.observe_collector_args,
      }), collectorName)
      // Serialize into the string shape the rest of the pipeline expects.
      // `observe_raw` is stored as a string and later substituted into the
      // ANALYZE prompt, so JSON stringify keeps downstream code unchanged.
      observeResult = JSON.stringify(collected, null, 2)
      // `collected_at` differs every run, so the unchanged-check compares
      // raw_data only, not the full collector envelope.
      observeFingerprint = JSON.stringify(collected.raw_data)
      logger.info(
        { pawId, collector: collectorName, errorCount: collected.errors?.length ?? 0 },
        '[paws] OBSERVE via collector',
      )
      if (
        paw.config.skip_if_unchanged &&
        previousCycle?.phase === 'completed' &&
        previousCycle.state?.observe_fingerprint === observeFingerprint
      ) {
        updateCycle(db, cycleId, {
          phase: 'completed',
          report: null,
          completed_at: Date.now(),
          state: {
            observe_raw: observeResult,
            observe_fingerprint: observeFingerprint,
            analysis: null,
            decisions: null,
            approval_requested: false,
            approval_granted: null,
            act_result: null,
          },
          // Carry the previous cycle's findings forward so the dedupe
          // history (getLatestCycleBefore / forceSeenFindingsToKnown) does
          // not go blind after a run of skipped cycles.
          findings: previousCycle?.findings ?? [],
        })
        logger.info({ pawId, cycleId }, '[paws] Collector output unchanged, cycle skipped')
        return cycleId
      }
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
      observe_fingerprint: observeFingerprint,
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
      findings = normalizeFindings(parsed.findings)
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
    findings = forceSeenFindingsToKnown(db, pawId, cycleId, findings)

    state.analysis = analyzeResult
    updateCycle(db, cycleId, { phase: 'decide', state, findings })

    if (paw.config.post_analyze_handler) {
      const analyzeHandler = getHandler(paw.config.post_analyze_handler)
      if (analyzeHandler) {
        try {
          await analyzeHandler(cycleId, pawId, paw.project_id, analyzeResult)
        } catch (err) {
          logger.error({ err, cycleId, handler: paw.config.post_analyze_handler },
            '[paws] post_analyze_handler threw, continuing to DECIDE')
        }
      }
    }

    // DECIDE
    const decideResult = await runPhase(paw, 'decide', {
      findings,
      analysis: analyzeResult,
    }, runAgent)

    let decisions: PawDecision[] = []
    let maxSeverity = 0
    try {
      const parsed = JSON.parse(decideResult)
      decisions = normalizeDecisions(parsed.decisions, findings)
      maxSeverity = Math.max(0, ...findings.map(f => f.severity))
    } catch {
      maxSeverity = Math.max(0, ...findings.map(f => f.severity))
    }

    // A decision the DECIDE phase marks `escalate` is by definition something
    // a person has to approve, so its finding must reach the approval
    // threshold whatever severity ANALYZE gave it. Generic: any paw whose
    // DECIDE phase escalates parks the cycle (ruling N2, second half).
    const escalated = new Set(decisions.filter(d => d.action === 'escalate').map(d => d.finding_id))
    if (escalated.size > 0) {
      findings = findings.map(f => (escalated.has(f.id) ? { ...f, severity: Math.max(f.severity, 4) } : f))
      updateCycle(db, cycleId, { findings })
    }

    state.decisions = decisions
    updateCycle(db, cycleId, { state })

    // Check if approval is needed
    const actionFindings = findings.filter(
      f => f.is_new !== false && f.severity >= clampThreshold(paw.config.approval_threshold),
    )

    if (actionFindings.length > 0) {
      state.approval_requested = true
      // Stamp when the approval card is sent so the reaper measures the user's
      // response window from card delivery, not from cycle start. Without this a
      // slow OBSERVE/ANALYZE/DECIDE run silently consumes the whole timeout.
      state.approval_requested_at = Date.now()
      updateCycle(db, cycleId, { state })

      // Mark paw as waiting_approval so the scheduler skips it until resolved
      updatePawStatus(db, pawId, 'waiting_approval')

      // Build plain-English approval message
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
      // The cycle card carries approve and skip only. A Paw Dev ask button
      // names one card, so it rides on that card's own message: the builder's
      // merge card and the triage handler's reply asks (final review,
      // Important 6).
      const card = buildApprovalCard(paw, projectName, cardFindings, Date.now())

      if (pawSend) {
        await pawSend(paw.config.chat_id, card.text, card.keyboard, paw.project_id)
      } else if (sendApproval) {
        await sendApproval(paw.config.chat_id, card.text, pawId, paw.project_id)
      } else {
        await send(
          paw.config.chat_id,
          card.text + `\n\nReply "approve ${pawId}" to continue or "skip ${pawId}" to skip.`,
          paw.project_id,
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
    // No meta header: the report is a routine message, so it lands in the
    // digest buffer and the 08:00 drain groups it by project (spec 5.4).
    await send(paw.config.chat_id, `${paw.name}: ${reportResult}`, paw.project_id)
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

function normalizeFindingToken(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, ' ')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b\d[\d,./:-]*\b/g, '#')
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function clampSeverity(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(5, Math.round(n)))
}

/**
 * approval_threshold lives on the same 1..5 scale as severity, so a stored 6
 * silently disables the gate. Read it honestly: above 5 reads as 5, below 1
 * reads as 1, and a missing value reads as 4 (spec 4.6).
 */
export function clampThreshold(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 4
  return Math.max(1, Math.min(5, Math.round(n)))
}

function normalizeFindings(value: unknown): PawFinding[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw): PawFinding[] => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    const detail = typeof item.detail === 'string' ? item.detail.trim() : ''
    if (!title || !detail) return []

    const id = typeof item.id === 'string' && item.id.trim()
      ? item.id.trim()
      : normalizeFindingToken(title).replace(/\s+/g, '-')

    const evidence_urls = Array.isArray(item.evidence_urls)
      ? Array.from(new Set(
        item.evidence_urls
          .filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
          .map(url => normalizeUrl(url.trim())),
      )).slice(0, 3)
      : undefined

    return [{
      id,
      severity: clampSeverity(item.severity),
      title,
      detail,
      is_new: item.is_new !== false,
      ...(evidence_urls && evidence_urls.length > 0 ? { evidence_urls } : {}),
    }]
  })
}

function normalizeDecisions(value: unknown, findings: PawFinding[]): PawDecision[] {
  if (!Array.isArray(value)) return []
  const findingById = new Map(findings.map(f => [f.id, f]))
  const validActions = new Set(['act', 'skip', 'escalate'])

  return value.flatMap((raw): PawDecision[] => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    const findingId = typeof item.finding_id === 'string' ? item.finding_id.trim() : ''
    const action = typeof item.action === 'string' ? item.action.trim() : ''
    const reason = typeof item.reason === 'string' ? item.reason.trim() : ''
    const finding = findingById.get(findingId)
    if (!findingId || !finding) return []
    if (!validActions.has(action)) return []
    if (finding.is_new === false && action !== 'skip') {
      return [{
        finding_id: findingId,
        action: 'skip',
        reason: 'suppressed by engine: finding already known',
      }]
    }
    return [{
      finding_id: findingId,
      action: action as PawDecision['action'],
      reason: reason || 'no reason given',
    }]
  })
}

function buildSeenFindingMaps(cycles: PawCycle[]): { byId: Map<string, number>; byTitle: Map<string, number> } {
  const byId = new Map<string, number>()
  const byTitle = new Map<string, number>()

  for (const cycle of cycles) {
    for (const finding of cycle.findings) {
      const idKey = normalizeFindingToken(finding.id)
      const titleKey = normalizeFindingToken(finding.title)
      if (idKey) byId.set(idKey, Math.max(byId.get(idKey) ?? 0, finding.severity))
      if (titleKey) byTitle.set(titleKey, Math.max(byTitle.get(titleKey) ?? 0, finding.severity))
    }
  }

  return { byId, byTitle }
}

function forceSeenFindingsToKnown(
  db: InstanceType<typeof Database>,
  pawId: string,
  cycleId: string,
  findings: PawFinding[],
): PawFinding[] {
  const priorCycles = listCycles(db, pawId, FINDING_DEDUPE_HISTORY_LIMIT + 1)
    .filter(c => c.id !== cycleId && (c.phase === 'completed' || c.phase === 'failed'))
    .slice(0, FINDING_DEDUPE_HISTORY_LIMIT)

  if (priorCycles.length === 0) return findings

  const seen = buildSeenFindingMaps(priorCycles)
  return findings.map((finding) => {
    if (finding.is_new === false) return finding

    const seenSeverity = Math.max(
      seen.byId.get(normalizeFindingToken(finding.id)) ?? 0,
      seen.byTitle.get(normalizeFindingToken(finding.title)) ?? 0,
    )

    // Same finding at the same or higher severity was already surfaced in a
    // recent cycle. Keep it known so paws remain delta-based instead of
    // re-alerting on the same issue when the model re-emits it as "new".
    if (seenSeverity >= finding.severity) {
      return { ...finding, is_new: false }
    }
    return finding
  })
}

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
  // always_run_act keeps a routine whose post-ACT handler drains a queue from
  // going idle on a quiet cycle. Paw Dev sets it: a card queued on Monday must
  // still be built on a Tuesday with nothing new (final review, Important 10).
  if (!paw.config.always_run_act && !hasMeaningfulWork(findings, decisions)) {
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

  // Run post-ACT handler if configured.  Handlers do the deterministic work
  // (DB inserts, notify.sh) that the agent cannot actually execute — agents
  // running on non-claude_desktop providers have no real tool access and will
  // hallucinate Bash/SQLite execution.  The ACT phase text is the handler's
  // sole input; it must contain a structured JSON block the handler can parse.
  let handlerReport: string | null = null
  if (paw.config.post_act_handler) {
    const handler = getHandler(paw.config.post_act_handler)
    if (handler) {
      try {
        const out = await handler(cycleId, paw.id, paw.project_id, actResult)
        if (typeof out === 'string' && out.trim().length > 0) handlerReport = out
      } catch (err) {
        logger.error(
          { err, cycleId, handler: paw.config.post_act_handler },
          '[paws] post_act_handler threw — continuing to REPORT phase',
        )
      }
    }
  }

  updateCycle(db, cycleId, { phase: 'report' })

  // A handler that produced the report has already done the work
  // deterministically. Skipping the REPORT model call keeps the numbers
  // honest and the cycle cheap (Task 10).
  let reportResult: string
  if (handlerReport) {
    reportResult = handlerReport
  } else {
    // Bug 3 fix: REPORT phase failures should not mark a completed cycle as failed
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
    // No meta header: the report is a routine message, so it lands in the
    // digest buffer and the 08:00 drain groups it by project (spec 5.4).
    await send(paw.config.chat_id, `${paw.name}: ${reportResult}`, paw.project_id)
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

  let result: AgentRunResult
  try {
    result = await runAgent(prompt, phase)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    throw new Error(`${phase.toUpperCase()} phase failed: ${errMsg}`)
  }
  if (!result.text || result.text.trim().length === 0) {
    const detail = result.emptyReason
      ?? (result.resultSubtype ? `Agent ended with subtype "${result.resultSubtype}".` : '')
    throw new Error(detail
      ? `Agent returned no text for ${phase} phase. ${detail}`
      : `Agent returned no text for ${phase} phase`)
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
