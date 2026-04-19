import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `claudepaw-action-items-test-${process.pid}`)

vi.mock('./config.js', () => {
  const path = require('node:path')
  const os = require('node:os')
  const dir = path.join(os.tmpdir(), `claudepaw-action-items-test-${process.pid}`)
  return { STORE_DIR: dir, PROJECT_ROOT: dir }
})

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  canTransition,
  nextStatusFor,
  createActionItem,
  transitionActionItem,
  parseActionItemsFromAgentOutput,
} from './action-items.js'
import {
  getActionItem,
  listActionItemEvents,
  initDatabase,
} from './db.js'

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  initDatabase()
})

afterAll(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('canTransition', () => {
  it('allows proposed -> approved', () => {
    expect(canTransition('proposed', 'approved')).toBe(true)
  })
  it('allows proposed -> rejected', () => {
    expect(canTransition('proposed', 'rejected')).toBe(true)
  })
  it('allows approved -> in_progress', () => {
    expect(canTransition('approved', 'in_progress')).toBe(true)
  })
  it('allows in_progress -> completed', () => {
    expect(canTransition('in_progress', 'completed')).toBe(true)
  })
  it('allows in_progress -> blocked', () => {
    expect(canTransition('in_progress', 'blocked')).toBe(true)
  })
  it('allows non-terminal -> paused', () => {
    expect(canTransition('approved', 'paused')).toBe(true)
    expect(canTransition('in_progress', 'paused')).toBe(true)
    expect(canTransition('blocked', 'paused')).toBe(true)
  })
  it('allows paused -> approved', () => {
    expect(canTransition('paused', 'approved')).toBe(true)
  })
  it('rejects archived -> anything', () => {
    expect(canTransition('archived', 'approved')).toBe(false)
    expect(canTransition('archived', 'in_progress')).toBe(false)
  })
  it('rejects completed -> in_progress', () => {
    expect(canTransition('completed', 'in_progress')).toBe(false)
  })
  it('allows any state -> archived', () => {
    expect(canTransition('completed', 'archived')).toBe(true)
    expect(canTransition('rejected', 'archived')).toBe(true)
    expect(canTransition('proposed', 'archived')).toBe(true)
  })
})

describe('nextStatusFor', () => {
  it('routes executable items to in_progress', () => {
    expect(nextStatusFor('approve', true)).toBe('in_progress')
  })
  it('routes manual items to approved', () => {
    expect(nextStatusFor('approve', false)).toBe('approved')
  })
})

describe('createActionItem', () => {
  it('creates a proposed item with defaults', () => {
    const id = createActionItem({
      project_id: 'default',
      title: 'Test item',
      source: 'test',
      proposed_by: 'human',
    })
    const item = getActionItem(id)
    expect(item).toBeDefined()
    expect(item!.status).toBe('proposed')
    expect(item!.priority).toBe('medium')
    expect(item!.executable_by_agent).toBe(0)
    const events = listActionItemEvents(id)
    expect(events).toHaveLength(1)
    expect(events[0].event_type).toBe('created')
  })

  it('honors explicit priority and executable flag', () => {
    const id = createActionItem({
      project_id: 'default',
      title: 'Agent task',
      source: 'scout',
      proposed_by: 'scout',
      priority: 'high',
      executable_by_agent: true,
    })
    const item = getActionItem(id)!
    expect(item.priority).toBe('high')
    expect(item.executable_by_agent).toBe(1)
  })
})

describe('transitionActionItem', () => {
  it('moves proposed -> approved and logs an event', () => {
    const id = createActionItem({
      project_id: 'default', title: 'X', source: 't', proposed_by: 'human',
    })
    transitionActionItem(id, 'approved', 'human')
    expect(getActionItem(id)!.status).toBe('approved')
    const events = listActionItemEvents(id).filter(e => e.event_type === 'status_changed')
    expect(events).toHaveLength(1)
    expect(events[0].old_value).toBe('proposed')
    expect(events[0].new_value).toBe('approved')
  })

  it('throws on illegal transition', () => {
    const id = createActionItem({
      project_id: 'default', title: 'Y', source: 't', proposed_by: 'human',
    })
    transitionActionItem(id, 'rejected', 'human')
    expect(() => transitionActionItem(id, 'in_progress', 'human')).toThrow(/illegal/i)
  })

  it('sets completed_at when entering completed', () => {
    const id = createActionItem({
      project_id: 'default', title: 'Z', source: 't', proposed_by: 'human',
    })
    transitionActionItem(id, 'approved', 'human')
    transitionActionItem(id, 'in_progress', 'human')
    transitionActionItem(id, 'completed', 'human')
    const item = getActionItem(id)!
    expect(item.completed_at).toBeTypeOf('number')
    expect(item.completed_at).toBeGreaterThan(0)
  })
})

describe('parseActionItemsFromAgentOutput', () => {
  it('returns empty array when no Action Items section', () => {
    expect(parseActionItemsFromAgentOutput('just some text')).toEqual([])
  })

  it('parses a simple list', () => {
    const text = `
blah blah

## Action Items
- [ ] First item
- [ ] Second item

other text after
`
    const items = parseActionItemsFromAgentOutput(text)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('First item')
    expect(items[1].title).toBe('Second item')
  })

  it('parses inline attributes: priority, executable, due', () => {
    const text = `
## Action Items
- [ ] Deploy dashboard (executable, high, due: 2026-05-01)
- [ ] Review Q2 budget (medium)
`
    const items = parseActionItemsFromAgentOutput(text)
    expect(items[0].title).toBe('Deploy dashboard')
    expect(items[0].priority).toBe('high')
    expect(items[0].executable_by_agent).toBe(true)
    expect(items[0].target_date).toBe(new Date('2026-05-01').getTime())
    expect(items[1].priority).toBe('medium')
    expect(items[1].executable_by_agent).toBeUndefined()
  })

  it('ignores completed checkboxes', () => {
    const text = `
## Action Items
- [x] Already done
- [ ] Still open
`
    const items = parseActionItemsFromAgentOutput(text)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Still open')
  })
})
