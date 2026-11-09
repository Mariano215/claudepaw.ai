import { describe, it, expect } from 'vitest'
import { selectBulkTargets } from './bulk-provider.js'

// Neutral fixture ids: this is a pure-logic test, project names are arbitrary.
const PROJECTS = [
  { id: 'alpha', execution_pinned: 0 },
  { id: 'beta', execution_pinned: 0 },
  { id: 'gamma', execution_pinned: 1 },
  { id: 'delta', execution_pinned: 1 },
  { id: 'epsilon', execution_pinned: null },
]

describe('selectBulkTargets', () => {
  it('applies to all non-pinned projects by default', () => {
    const sel = selectBulkTargets(PROJECTS)
    expect(sel.applied).toEqual(['alpha', 'beta', 'epsilon'])
    expect(sel.skippedPinned).toEqual(['gamma', 'delta'])
    expect(sel.skippedUnknown).toEqual([])
  })

  it('includes pinned projects when includePinned is true', () => {
    const sel = selectBulkTargets(PROJECTS, { includePinned: true })
    expect(sel.applied).toEqual(['alpha', 'beta', 'gamma', 'delta', 'epsilon'])
    expect(sel.skippedPinned).toEqual([])
  })

  it('restricts to an explicit project_ids list and still honors the pin', () => {
    const sel = selectBulkTargets(PROJECTS, { projectIds: ['alpha', 'gamma'] })
    expect(sel.applied).toEqual(['alpha'])
    expect(sel.skippedPinned).toEqual(['gamma'])
  })

  it('can force a pinned project via explicit ids + includePinned', () => {
    const sel = selectBulkTargets(PROJECTS, { projectIds: ['gamma'], includePinned: true })
    expect(sel.applied).toEqual(['gamma'])
    expect(sel.skippedPinned).toEqual([])
  })

  it('reports unknown project ids without throwing', () => {
    const sel = selectBulkTargets(PROJECTS, { projectIds: ['alpha', 'ghost'] })
    expect(sel.applied).toEqual(['alpha'])
    expect(sel.skippedUnknown).toEqual(['ghost'])
  })

  it('treats execution_pinned null/undefined as not pinned', () => {
    const sel = selectBulkTargets([{ id: 'a' }, { id: 'b', execution_pinned: null }])
    expect(sel.applied).toEqual(['a', 'b'])
  })

  it('dedupes repeated ids in the request', () => {
    const sel = selectBulkTargets(PROJECTS, { projectIds: ['alpha', 'alpha'] })
    expect(sel.applied).toEqual(['alpha'])
  })

  it('treats an empty project_ids array as "all projects"', () => {
    const sel = selectBulkTargets(PROJECTS, { projectIds: [] })
    expect(sel.applied).toEqual(['alpha', 'beta', 'epsilon'])
  })
})
