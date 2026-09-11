export interface AgentDef {
  id: string
  name: string
  role: string
  emoji: string
  mode: 'always-on' | 'active' | 'on-demand'
  heartbeat_interval: string
}

/** Personal assistant agents for the default project (@YourBotName) */
export const PERSONAL_AGENTS: AgentDef[] = [
  { id: 'security-scanner', name: 'Security Scanner', role: 'Dependency and Infra Scanning', emoji: '\uD83D\uDEE1\uFE0F', mode: 'active', heartbeat_interval: '4h' },
  { id: 'api-monitor', name: 'API Monitor', role: 'Claude Platform and SDK Intelligence', emoji: '\uD83D\uDCE1', mode: 'active', heartbeat_interval: '6h' },
]

/** Content and YouTube agents for ClaudePaw */
export const MATTEI_SYSTEMS_AGENTS: AgentDef[] = [
  { id: 'content-researcher', name: 'Content Researcher', role: 'Video and Content Research', emoji: '\uD83D\uDD0D', mode: 'active', heartbeat_interval: '4h' },
  { id: 'video-producer', name: 'Video Producer', role: 'Video Builder', emoji: '\uD83C\uDFAC', mode: 'on-demand', heartbeat_interval: 'none' },
  { id: 'social-writer', name: 'Social Writer', role: 'LinkedIn, X and Article Writing', emoji: '\uD83D\uDCE2', mode: 'active', heartbeat_interval: '2h' },
  { id: 'platform-developer', name: 'Platform Developer', role: 'Code and Infrastructure', emoji: '\uD83D\uDD28', mode: 'on-demand', heartbeat_interval: 'none' },
]

/** @deprecated Use MATTEI_SYSTEMS_AGENTS instead. Kept for backwards compatibility. */
export const DEFAULT_AGENTS = MATTEI_SYSTEMS_AGENTS

export const CLAUDEPAW_AGENTS: AgentDef[] = [
  { id: 'ecosystem-researcher', name: 'Ecosystem Researcher', role: 'Competitive and Ecosystem Researcher', emoji: '\uD83D\uDD0D', mode: 'active', heartbeat_interval: '4h' },
]

// Paw Dev, spec 6.2. Named for what they do.
export const PAWDEV_AGENTS: AgentDef[] = [
  { id: 'triage', name: 'Triage', role: 'Repo Triage', emoji: '\uD83D\uDDC2\uFE0F', mode: 'active', heartbeat_interval: '8h' },
  { id: 'maintainer', name: 'Maintainer', role: 'Repo Health', emoji: '\uD83D\uDEE0\uFE0F', mode: 'active', heartbeat_interval: '8h' },
  { id: 'builder', name: 'Builder', role: 'Monorepo Builder', emoji: '\uD83D\uDD28', mode: 'on-demand', heartbeat_interval: 'none' },
  { id: 'reviewer', name: 'Reviewer', role: 'Diff Reviewer', emoji: '\uD83D\uDD0D', mode: 'on-demand', heartbeat_interval: 'none' },
]

export const GENERIC_PROJECT_AGENTS: AgentDef[] = [
  { id: 'platform-developer', name: 'Platform Developer', role: 'Code & Infrastructure', emoji: '\uD83D\uDD28', mode: 'on-demand', heartbeat_interval: 'none' },
  { id: 'ecosystem-researcher', name: 'Ecosystem Researcher', role: 'Research & Intelligence', emoji: '\uD83D\uDD0D', mode: 'active', heartbeat_interval: '4h' },
  { id: 'security-scanner', name: 'Security Scanner', role: 'Security Auditor', emoji: '\uD83D\uDEE1\uFE0F', mode: 'active', heartbeat_interval: '4h' },
]

/**
 * Get the agent roster for a given project. Unknown projects get the generic
 * roster (5 boilerplate agents), but this is a sign of a misconfiguration --
 * the `projects/<slug>/agents/` directory and this switch must stay in sync.
 * The agents.test.ts guard enforces that invariant at test time.
 */
export function getAgentsForProject(projectId: string): AgentDef[] {
  switch (projectId) {
    case 'default': return PERSONAL_AGENTS
    case 'claudepaw': return CLAUDEPAW_AGENTS
    case 'pawdev': return PAWDEV_AGENTS
    case 'default': return MATTEI_SYSTEMS_AGENTS
    case 'broker': return BROKER_AGENTS
    default: return GENERIC_PROJECT_AGENTS
  }
}

/** Build a project-scoped agent ID. Legacy 'default' project uses bare IDs (e.g. 'scout'). */
export function projectAgentId(projectId: string, templateId: string): string {
  if (projectId === 'default') return templateId
  return `${projectId}--${templateId}`
}

/** Parse a composite agent ID back to project + template. Bare IDs (no '--') are legacy 'default' project agents. */
export function parseAgentId(id: string): { projectId: string; templateId: string } {
  const idx = id.indexOf('--')
  if (idx === -1) return { projectId: 'default', templateId: id }
  return { projectId: id.substring(0, idx), templateId: id.substring(idx + 2) }
}
