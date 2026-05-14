// src/paws/approval-card.ts
import type { Paw, InlineKeyboard } from './types.js'

/**
 * A security-style finding. Shaped to match the row we read from
 * `security_findings`, but declared locally so this formatter stays pure
 * and has no imports from db.ts.
 */
export interface ApprovalFinding {
  id: string
  title: string
  detail: string
  severity: number // 1..5
  target: string
  auto_fixable: 0 | 1
}

function severityEmoji(sev: number): string {
  if (sev >= 4) return '🔴'
  if (sev === 3) return '🟡'
  return '⚪'
}

/**
 * Build the approval card: structured text body + inline keyboard.
 * Pure formatter — no I/O, no side effects, safe to unit-test.
 *
 * Keyboard: Approve (run ACT) / Reject (skip this cycle).
 */
export function buildApprovalCard(
  paw: Paw,
  projectName: string,
  findings: ApprovalFinding[],
  _cycleStartedAtMs: number,
): { text: string; keyboard: InlineKeyboard } {
  const findingWord = findings.length === 1 ? 'item' : 'items'
  const header = `${paw.name}  (${projectName})\n${findings.length} ${findingWord} need approval before ACT runs`
  const body = findings
    .map(f => `${severityEmoji(f.severity)} ${f.title}\n${f.detail}`)
    .join('\n\n')
  const text = `${header}\n\n${body}`

  const keyboard: InlineKeyboard = {
    inline_keyboard: [[
      { text: 'Approve', callback_data: `paw:approve:${paw.id}` },
      { text: 'Reject', callback_data: `paw:skip:${paw.id}` },
    ]],
  }

  return { text, keyboard }
}
