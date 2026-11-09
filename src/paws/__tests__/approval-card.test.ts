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
  cron: '0 */4 * * *',
} as unknown as Paw

describe('buildApprovalCard', () => {
  it('renders paw name, project, finding count and body', () => {
    const findings: TestFinding[] = [
      { id: 'f1', title: 'NPM CVEs — example-app', detail: 'path-to-regexp DoS', severity: 4, target: '/tmp/example-app', auto_fixable: 1 },
    ]
    const card = buildApprovalCard(paw, 'ClaudePaw', findings, 1700000000000)
    expect(card.text).toContain('Sentinel Security Patrol')
    expect(card.text).toContain('ClaudePaw')
    expect(card.text).toContain('1 item need approval')
    expect(card.text).toContain('🔴 NPM CVEs — example-app')
    expect(card.text).toContain('path-to-regexp DoS')
  })

  it('does not include meta/cron line or dashboard footer', () => {
    const findings: TestFinding[] = [
      { id: 'f1', title: 'a', detail: '', severity: 4, target: 't', auto_fixable: 0 },
    ]
    const card = buildApprovalCard(paw, 'ClaudePaw', findings, 1700000000000)
    expect(card.text).not.toContain('paw:')
    expect(card.text).not.toContain('cron:')
    expect(card.text).not.toContain('dashboard')
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

  it('keyboard has exactly one row with Approve and Reject at cycle level', () => {
    const findings: TestFinding[] = [
      { id: 'f1', title: 'a', detail: '', severity: 4, target: 't', auto_fixable: 0 },
      { id: 'f2', title: 'b', detail: '', severity: 3, target: 't', auto_fixable: 1 },
    ]
    const card = buildApprovalCard(paw, 'ClaudePaw', findings, 1700000000000)
    expect(card.keyboard.inline_keyboard).toHaveLength(1)
    expect(card.keyboard.inline_keyboard[0][0]).toEqual({ text: 'Approve', callback_data: 'paw:approve:sentinel-patrol' })
    expect(card.keyboard.inline_keyboard[0][1]).toEqual({ text: 'Reject', callback_data: 'paw:skip:sentinel-patrol' })
  })

  it('keyboard stays minimal even with many findings', () => {
    const findings: TestFinding[] = Array.from({ length: 10 }, (_, i) => ({
      id: `f${i}`, title: `t${i}`, detail: '', severity: 4, target: 't', auto_fixable: 0,
    }))
    const card = buildApprovalCard(paw, 'ClaudePaw', findings, 1700000000000)
    // Always just one row: Approve / Reject
    expect(card.keyboard.inline_keyboard).toHaveLength(1)
    // text body still lists all 10
    for (let i = 0; i < 10; i++) {
      expect(card.text).toContain(`t${i}`)
    }
  })
})
