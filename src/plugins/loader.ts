// ---------------------------------------------------------------------------
// Plugin loader -- scans plugins/ directory at startup
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { registerPlugin } from './registry.js'
import type { PluginManifest, Plugin } from './types.js'

const PLUGINS_DIR = join(PROJECT_ROOT, 'plugins')

function validateManifest(raw: unknown, dir: string): PluginManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>

  const required = ['id', 'name', 'version', 'author', 'description'] as const
  for (const field of required) {
    if (typeof m[field] !== 'string' || !(m[field] as string).trim()) {
      logger.warn('Plugin %s: missing or empty field "%s"', dir, field)
      return null
    }
  }

  if (!/^[a-z0-9-]+$/.test(m.id as string)) {
    logger.warn('Plugin %s: id must be lowercase alphanumeric with dashes', dir)
    return null
  }

  return {
    id: m.id as string,
    name: m.name as string,
    version: m.version as string,
    author: m.author as string,
    description: m.description as string,
    keywords: Array.isArray(m.keywords) ? m.keywords.filter((k): k is string => typeof k === 'string') : [],
    agent_id: typeof m.agent_id === 'string' ? m.agent_id : undefined,
    dependencies: Array.isArray(m.dependencies) ? m.dependencies.filter((d): d is string => typeof d === 'string') : undefined,
  }
}

function loadSinglePlugin(pluginDir: string): Plugin | null {
  const manifestPath = join(pluginDir, 'manifest.json')
  const promptPath = join(pluginDir, 'prompt.md')

  if (!existsSync(manifestPath)) {
    logger.warn('No manifest.json in %s, skipping', pluginDir)
    return null
  }

  let manifestRaw: unknown
  try {
    manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch (err) {
    logger.warn({ err }, 'Failed to parse manifest.json in %s', pluginDir)
    return null
  }

  const manifest = validateManifest(manifestRaw, pluginDir)
  if (!manifest) return null

  let prompt = ''
  if (existsSync(promptPath)) {
    try {
      prompt = readFileSync(promptPath, 'utf-8').trim()
    } catch (err) {
      logger.warn({ err }, 'Failed to read prompt.md in %s', pluginDir)
    }
  }

  return {
    manifest,
    prompt,
    enabled: true,
    path: pluginDir,
  }
}

export function loadAllPlugins(): number {
  if (!existsSync(PLUGINS_DIR)) {
    logger.info('No plugins/ directory found, skipping plugin load')
    return 0
  }

  let entries: string[]
  try {
    entries = readdirSync(PLUGINS_DIR)
  } catch (err) {
    logger.error({ err }, 'Failed to read plugins directory')
    return 0
  }

  let loaded = 0
  for (const entry of entries) {
    // Skip non-directories and dotfiles
    if (entry.startsWith('.') || entry === 'README.md') continue
    const fullPath = join(PLUGINS_DIR, entry)
    try {
      if (!statSync(fullPath).isDirectory()) continue
    } catch {
      continue
    }

    const plugin = loadSinglePlugin(fullPath)
    if (plugin) {
      registerPlugin(plugin)
      loaded++
    }
  }

  logger.info('Plugin loader: %d plugin(s) loaded', loaded)
  return loaded
}
