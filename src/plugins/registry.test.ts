import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  registerPlugin,
  unregisterPlugin,
  getPlugin,
  listPlugins,
  getPluginsForAgent,
  setPluginEnabled,
  getPluginCount,
} from './registry.js'
import type { Plugin, PluginManifest } from './types.js'

function makePlugin(id: string, overrides: Partial<PluginManifest> = {}): Plugin {
  return {
    manifest: {
      id,
      name: `Plugin ${id}`,
      version: '1.0.0',
      agent_id: 'scout',
      ...overrides,
    } as PluginManifest,
    enabled: true,
  } as Plugin
}

describe('plugin registry', () => {
  beforeEach(() => {
    for (const p of listPlugins()) {
      unregisterPlugin(p.manifest.id)
    }
  })

  it('registers a plugin', () => {
    registerPlugin(makePlugin('a'))
    expect(getPluginCount()).toBe(1)
    expect(getPlugin('a')?.manifest.id).toBe('a')
  })

  it('replacing a registered id logs a warning and overwrites', async () => {
    const { logger } = await import('../logger.js')
    registerPlugin(makePlugin('a'))
    registerPlugin(makePlugin('a', { version: '2.0.0' }))
    expect(getPluginCount()).toBe(1)
    expect(getPlugin('a')?.manifest.version).toBe('2.0.0')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('unregister returns true when plugin existed', () => {
    registerPlugin(makePlugin('a'))
    expect(unregisterPlugin('a')).toBe(true)
    expect(getPlugin('a')).toBeUndefined()
  })

  it('unregister returns false when plugin never existed', () => {
    expect(unregisterPlugin('missing')).toBe(false)
  })

  it('listPlugins returns all registered', () => {
    registerPlugin(makePlugin('a'))
    registerPlugin(makePlugin('b'))
    const ids = listPlugins().map(p => p.manifest.id).sort()
    expect(ids).toEqual(['a', 'b'])
  })

  it('getPluginsForAgent filters by agent_id and enabled', () => {
    registerPlugin(makePlugin('a', { agent_id: 'scout' }))
    registerPlugin(makePlugin('b', { agent_id: 'scout' }))
    registerPlugin(makePlugin('c', { agent_id: 'auditor' }))
    setPluginEnabled('b', false)

    const scoutPlugins = getPluginsForAgent('scout')
    expect(scoutPlugins.map(p => p.manifest.id)).toEqual(['a'])
  })

  it('setPluginEnabled returns true on success, false when missing', () => {
    registerPlugin(makePlugin('a'))
    expect(setPluginEnabled('a', false)).toBe(true)
    expect(getPlugin('a')?.enabled).toBe(false)
    expect(setPluginEnabled('missing', true)).toBe(false)
  })

  it('getPluginCount reflects registrations and unregistrations', () => {
    expect(getPluginCount()).toBe(0)
    registerPlugin(makePlugin('a'))
    registerPlugin(makePlugin('b'))
    expect(getPluginCount()).toBe(2)
    unregisterPlugin('a')
    expect(getPluginCount()).toBe(1)
  })
})
