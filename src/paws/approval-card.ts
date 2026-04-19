// src/paws/approval-card.ts
import type { Paw, InlineKeyboard, InlineKeyboardButton } from './types.js'

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

const MAX_FINDING_ROWS = 7

function severityEmoji(sev: number): string {
  if (sev >= 4) return '🔴'
  if (sev === 3) return '🟡'
  return '⚪'
}

/** Last path segment or hostname — whichever reads cleanest as a button label. */
function shortTargetLabel(target: string): string {
  const trimmed = target.replace(/\/+$/, '')
  const segments = trimmed.split('/')
  return segments[segments.length - 1] || trimmed
}

function findingRow(f: ApprovalFinding): InlineKeyboardButton[] {
  const primary: InlineKeyboardButton = f.auto_fixable === 1
    ? { text: `Fix ${shortTargetLabel(f.target)}`, callback_data: `pf:fix:${f.id}` }
    : { text: '→ Dashboard', callback_data: `pf:dash:${f.id}` }
  const dismiss: InlineKeyboardButton = { text: 'Dismiss', callback_data: `pf:dismiss:${f.id}` }
  return [primary, dismiss]
}

/**
 * Build the approval card: structured text body + inline keyboard.
 * Pure formatter — no I/O, no side effects, safe to unit-test.
 */
export function buildApprovalCard(
  paw: Paw,
  projectName: string,
  findings: ApprovalFinding[],
  cycleStartedAtMs: number,
): { text: string; keyboard: InlineKeyboard } {
  const findingWord = findings.length === 1 ? 'finding' : 'findings'
  const header = `🛡 ${paw.name}\n${projectName}  •  ${findings.length} ${findingWord} need your call`
  const body = findings
    .map(f => `${severityEmoji(f.severity)} ${f.title}\n${f.detail}`)
    .join('\n\n')
  const text = `${header}\n\n${body}`

  const rows: InlineKeyboardButton[][] = []
  const visible = findings.slice(0, MAX_FINDING_ROWS)
  for (const f of visible) rows.push(findingRow(f))

  if (findings.length > MAX_FINDING_ROWS) {
    rows.push([
      { text: '→ Dashboard for full list', callback_data: `pf:dash-all:${paw.id}` },
    ])
  }

  const cycleStamp = Math.floor(cycleStartedAtMs / 1000)
  rows.push([{ text: 'Dismiss All', callback_data: `pf:dismiss-all:${paw.id}:${cycleStamp}` }])
  return { text, keyboard: { inline_keyboard: rows } }
}
