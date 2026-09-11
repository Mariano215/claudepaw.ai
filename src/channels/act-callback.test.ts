import { describe, it, expect, vi, beforeEach } from 'vitest'

const items = new Map<string, { id: string; project_id: string; status: string; source: string }>()
const transitions: Array<{ id: string; to: string; actor: string }> = []
const audits: Array<Record<string, unknown>> = []

vi.mock('../db.js', () => ({
  getActionItem: vi.fn((id: string) => items.get(id)),
}))

vi.mock('../action-items.js', () => ({
  transitionActionItem: vi.fn((id: string, to: string, actor: string) => {
    const item = items.get(id)
    if (!item) throw new Error(`action item not found: ${id}`)
    transitions.push({ id, to, actor })
    item.status = to
  }),
}))

vi.mock('../policy.js', () => ({
  writeAudit: vi.fn((row: Record<string, unknown>) => { audits.push(row); return 1 }),
}))

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { handleActCallback } from './act-callback.js'

describe('handleActCallback', () => {
  beforeEach(() => {
    items.clear(); transitions.length = 0; audits.length = 0
    items.set('c1', { id: 'c1', project_id: 'default', status: 'proposed', source: 'social.post' })
  })

  it('approve moves the card to approved and audits the tap', () => {
    const res = handleActCallback('c1', true, 'owner')
    expect(res.ok).toBe(true)
    expect(transitions).toEqual([{ id: 'c1', to: 'approved', actor: 'owner' }])
    expect(audits[0].decision).toBe('allow')
    expect(audits[0].ref_id).toBe('c1')
  })

  it('deny moves the card to rejected and audits the tap', () => {
    const res = handleActCallback('c1', false, 'owner')
    expect(res.ok).toBe(true)
    expect(transitions).toEqual([{ id: 'c1', to: 'rejected', actor: 'owner' }])
    expect(audits[0].decision).toBe('deny')
  })

  it('reports a missing card without throwing', () => {
    const res = handleActCallback('nope', true, 'owner')
    expect(res.ok).toBe(false)
    expect(res.message).toContain('not found')
    expect(audits).toHaveLength(0)
  })

  it('is idempotent on an already answered card', () => {
    items.get('c1')!.status = 'approved'
    const res = handleActCallback('c1', true, 'owner')
    expect(res.ok).toBe(true)
    expect(res.message).toContain('already')
    expect(transitions).toHaveLength(0)
  })
})
