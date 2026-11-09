// src/paws/__tests__/project-name.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getProjectName, __setProjectLookupForTests } from '../project-name.js'

describe('getProjectName', () => {
  beforeEach(() => {
    __setProjectLookupForTests(undefined)
  })

  it('returns "ClaudePaw" for the default project', () => {
    expect(getProjectName('default')).toBe('ClaudePaw')
  })

  it('returns the project name when a row exists', () => {
    __setProjectLookupForTests((id: string) =>
      id === 'example-project' ? { id, name: 'Example Project' } : undefined,
    )
    expect(getProjectName('example-project')).toBe('Example Project')
  })

  it('falls back to the raw project id when no row is found', () => {
    __setProjectLookupForTests(() => undefined)
    expect(getProjectName('unknown-project')).toBe('unknown-project')
  })
})
