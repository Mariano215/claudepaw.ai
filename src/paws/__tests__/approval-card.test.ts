// src/paws/__tests__/approval-card.test.ts
import { describe, it, expect } from 'vitest'
import { buildApprovalCard } from '../approval-card.js'
import type { Paw } from '../types.js'

type TestFinding = {
  id: string
  title: string
  detail: string
  severity: 1 | 2 | 3 | 4 | 5
  target: string
  auto_fixable: 0 | 1
}

const paw = {
  id: 'sentinel-patrol',
  name: 'Sentinel Security Patrol',
  project_id: 'default',
} as unknown as Paw

describe('buildApprovalCard', () => {
  it('renders project header with emoji, name and finding count', () => {
    const findings: TestFinding[] = [
      { id: 'f1', title: 'NPM CVEs — example-app', detail: 'path-to-regexp DoS', severity: 4, target: '/tmp/example-app', auto_fixable: 1 },
    ]
    const card = buildApprovalCard(paw, 'ClaudePaw', findings, 1700000000000)
    expect(card.text).toContain('🛡 Sentinel Security Patrol')
    expect(card.text).toContain('ClaudePaw  •  1 finding')
    expect(card.text).toContain('🔴 NPM CVEs — example-app')
    expect(card.text).toContain('path-to-regexp DoS')
  })

  it('uses 🔴 for high/critical (severity >= 4), 🟡 for medium (3), ⚪ for low (<=2)', () => {
    const findings: TestFinding[] = [
      { id: 'f1', title: 'crit', detail: '', severity: 5, target: 't', auto_fixable: 0 },
      { id: 'f2', title: 'med', detail: '', severity: 3, target: 't', auto_fixable: 0 },
      { id: 'f3', title: 'low', detail: '', severity: 2, target: 't', auto_fixable: 0 },
    ]
    const card = buildApprovalCard(paw, 'ClaudePaw', findings, 1700000000000)
    expect(card.text).toContain('🔴 crit')
    expect(card.text).toContain('🟡 med')
    expect(card.text).toContain('⚪ low')
  })

  it('renders [Fix X] only for auto_fixable findings, [→ Dashboard] otherwise', () => {
    const findings: TestFinding[] = [
      { id: 'f1', title: 'Fixable', detail: '', severity: 4, target: '/path/to/proj', auto_fixable: 1 },
      { id: 'f2', title: 'Manual', detail: '', severity: 4, target: 'server-x', auto_fixable: 0 },
    ]
    const card = buildApprovalCard(paw, 'ClaudePaw', findings, 1700000000000)
    // row 0 = fixable
    expect(card.keyboard.inline_keyboard[0][0].text).toBe('Fix proj')
    expect(card.keyboard.inline_keyboard[0][0].callback_data).toBe('pf:fix:f1')
    expect(card.keyboard.inline_keyboard[0][1].text).toBe('Dismiss')
    expect(card.keyboard.inline_keyboard[0][1].callback_data).toBe('pf:dismiss:f1')
    // row 1 = manual
    expect(card.keyboard.inline_keyboard[1][0].text).toBe('→ Dashboard')
    expect(card.keyboard.inline_keyboard[1][0].callback_data).toBe('pf:dash:f2')
  })

  it('includes a [Dismiss All] row with the paw id', () => {
    const findings: TestFinding[] = [
      { id: 'f1', title: 'a', detail: '', severity: 4, target: 't', auto_fixable: 0 },
    ]
    const card = buildApprovalCard(paw, 'ClaudePaw', findings, 1700000000000)
    const last = card.keyboard.inline_keyboard[card.keyboard.inline_keyboard.length - 1]
    expect(last).toEqual([{ text: 'Dismiss All', callback_data: 'pf:dismiss-all:sentinel-patrol:1700000000' }])
  })

  it('caps keyboard at 7 per-finding rows + overflow + dismiss-all when > 7 findings', () => {
    const findings: TestFinding[] = Array.from({ length: 10 }, (_, i) => ({
      id: `f${i}`, title: `t${i}`, detail: '', severity: 4, target: 't', auto_fixable: 0,
    }))
    const card = buildApprovalCard(paw, 'ClaudePaw', findings, 1700000000000)
    // 7 finding rows + 1 overflow row + 1 dismiss-all row = 9 total
    expect(card.keyboard.inline_keyboard).toHaveLength(9)
    const overflow = card.keyboard.inline_keyboard[7]
    expect(overflow[0].text).toBe('→ Dashboard for full list')
    expect(overflow[0].callback_data).toBe('pf:dash-all:sentinel-patrol')
    // text body still lists all 10
    for (let i = 0; i < 10; i++) {
      expect(card.text).toContain(`t${i}`)
    }
  })
})
