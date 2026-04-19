// ---------------------------------------------------------------------------
// Plugin registry -- in-memory store of loaded plugins
// ---------------------------------------------------------------------------

import type { Plugin, PluginManifest } from './types.js'
import { logger } from '../logger.js'

const plugins = new Map<string, Plugin>()

export function registerPlugin(plugin: Plugin): void {
  if (plugins.has(plugin.manifest.id)) {
    logger.warn('Plugin %s already registered, replacing', plugin.manifest.id)
  }
  plugins.set(plugin.manifest.id, plugin)
  logger.info('Registered plugin: %s v%s', plugin.manifest.name, plugin.manifest.version)
}

export function unregisterPlugin(id: string): boolean {
  const existed = plugins.delete(id)
  if (existed) {
    logger.info('Unregistered plugin: %s', id)
  }
  return existed
}

export function getPlugin(id: string): Plugin | undefined {
  return plugins.get(id)
}

export function listPlugins(): Plugin[] {
  return [...plugins.values()]
}

export function getPluginsForAgent(agentId: string): Plugin[] {
  return [...plugins.values()].filter(
    (p) => p.enabled && p.manifest.agent_id === agentId,
  )
}

export function setPluginEnabled(id: string, enabled: boolean): boolean {
  const plugin = plugins.get(id)
  if (!plugin) return false
  plugin.enabled = enabled
  logger.info('Plugin %s %s', id, enabled ? 'enabled' : 'disabled')
  return true
}

export function getPluginCount(): number {
  return plugins.size
}
