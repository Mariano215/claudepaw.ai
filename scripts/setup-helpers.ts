/**
 * Extractable helpers from the ClaudePaw setup wizard.
 * Kept separate so they can be unit-tested independently.
 */

import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Validation regex patterns
// ---------------------------------------------------------------------------

/** Telegram bot token: digits, colon, alphanumeric/underscore/dash */
export const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/

/** Numeric chat ID (positive integers only) */
export const CHAT_ID_RE = /^\d+$/

/** Slug: lowercase letters, digits, hyphens only */
export const SLUG_RE = /^[a-z0-9-]+$/

/** Hex color: # followed by exactly 6 hex digits */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

// ---------------------------------------------------------------------------
// Slug helper
// ---------------------------------------------------------------------------
export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// ---------------------------------------------------------------------------
// Agent frontmatter parser
// ---------------------------------------------------------------------------
export interface AgentMeta {
  id: string
  name: string
  emoji: string
  role: string
  mode: string
}

/**
 * Parse YAML-like frontmatter from an agent markdown file.
 * Accepts either a file path (string) or raw content (string) --
 * if the string starts with "---", it's treated as raw content.
 */
export function parseAgentFrontmatter(filePathOrContent: string): AgentMeta | null {
  let content: string
  if (filePathOrContent.startsWith('---')) {
    content = filePathOrContent
  } else {
    content = readFileSync(filePathOrContent, 'utf-8')
  }

  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null

  const yaml = match[1]
  const get = (key: string): string => {
    const m = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    if (!m) return ''
    let val = m[1].trim()
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    // Handle unicode escapes like \U0001F4E2
    val = val.replace(/\\U([0-9A-Fa-f]{8})/g, (_, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    return val
  }

  const id = get('id')
  const name = get('name')
  const emoji = get('emoji')
  const role = get('role')
  const mode = get('mode')

  if (!id || !name) return null
  return { id, name, emoji, role, mode }
}

// ---------------------------------------------------------------------------
// Env file reader
// ---------------------------------------------------------------------------
/**
 * Parse a .env file string into key-value pairs.
 * Skips comments and blank lines, handles quoted values,
 * strips inline comments on unquoted values.
 */
export function readEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    // Strip inline comments (only if not inside quotes)
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.indexOf('#')
      if (commentIdx > 0) value = value.slice(0, commentIdx).trimEnd()
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

// ---------------------------------------------------------------------------
// Theme presets
// ---------------------------------------------------------------------------
export interface ThemePreset {
  name: string
  primary: string
  accent: string
}

export const THEME_PRESETS: ThemePreset[] = [
  { name: 'Midnight', primary: '#1e1b4b', accent: '#7c3aed' },
  { name: 'Forest', primary: '#14532d', accent: '#22c55e' },
  { name: 'Ocean', primary: '#0c4a6e', accent: '#06b6d4' },
  { name: 'Ember', primary: '#7c2d12', accent: '#f97316' },
  { name: 'Slate', primary: '#1e293b', accent: '#64748b' },
]
