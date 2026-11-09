// ---------------------------------------------------------------------------
// Plugin system types
// ---------------------------------------------------------------------------

export interface PluginManifest {
  id: string                   // unique kebab-case identifier
  name: string                 // display name
  version: string              // semver string
  author: string               // who wrote it
  description: string          // what this plugin does
  keywords: string[]           // for discovery/search
  agent_id?: string            // which agent this extends (optional)
  dependencies?: string[]      // other plugin IDs this depends on
}

export interface Plugin {
  manifest: PluginManifest
  prompt: string               // contents of prompt.md
  enabled: boolean             // runtime toggle
  path: string                 // absolute path to plugin directory
}
