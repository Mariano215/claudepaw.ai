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
  { id: 'auditor', name: 'Auditor', role: 'Security Auditor', emoji: '\uD83D\uDEE1\uFE0F', mode: 'active', heartbeat_interval: '4h' },
  { id: 'builder', name: 'Builder', role: 'Code & Infrastructure', emoji: '\uD83D\uDD28', mode: 'on-demand', heartbeat_interval: 'none' },
  { id: 'scout', name: 'Scout', role: 'Research & Intelligence', emoji: '\uD83D\uDD0D', mode: 'active', heartbeat_interval: '4h' },
  { id: 'sentinel', name: 'Sentinel', role: 'Monitoring & Alerts', emoji: '\uD83D\uDC41\uFE0F', mode: 'always-on', heartbeat_interval: '1h' },
  { id: 'healer', name: 'Healer', role: 'Metric Self-Healing', emoji: '\uD83E\uDE7A', mode: 'active', heartbeat_interval: '6h' },
  { id: 'advocate', name: 'Advocate', role: "Devil's Advocate", emoji: '\uD83D\uDE08', mode: 'on-demand', heartbeat_interval: 'none' },
]

/** Content/YouTube agents for ClaudePaw project */
export const MATTEI_SYSTEMS_AGENTS: AgentDef[] = [
  { id: 'scout', name: 'Scout', role: 'Video & Content Researcher', emoji: '\uD83D\uDD0D', mode: 'active', heartbeat_interval: '4h' },
  { id: 'producer', name: 'Producer', role: 'Video Builder', emoji: '\uD83C\uDFAC', mode: 'on-demand', heartbeat_interval: 'none' },
  { id: 'qa', name: 'QA', role: 'Quality Reviewer', emoji: '\u2705', mode: 'on-demand', heartbeat_interval: 'none' },
  { id: 'social', name: 'Social', role: 'LinkedIn & X Manager', emoji: '\uD83D\uDCE2', mode: 'active', heartbeat_interval: '2h' },
  { id: 'sentinel', name: 'Sentinel', role: 'Social Monitor', emoji: '\uD83D\uDC41\uFE0F', mode: 'always-on', heartbeat_interval: '1h' },
  { id: 'analyst', name: 'Analyst', role: 'YouTube Analytics', emoji: '\uD83D\uDCCA', mode: 'active', heartbeat_interval: '6h' },
  { id: 'brand', name: 'Brand', role: 'Brand Strategist', emoji: '\uD83C\uDFAF', mode: 'on-demand', heartbeat_interval: 'none' },
  { id: 'advocate', name: 'Advocate', role: "Devil's Advocate", emoji: '\uD83D\uDE08', mode: 'on-demand', heartbeat_interval: 'none' },
  { id: 'auditor', name: 'Auditor', role: 'Security Auditor', emoji: '\uD83D\uDEE1\uFE0F', mode: 'active', heartbeat_interval: '4h' },
  { id: 'builder', name: 'Builder', role: 'Code & Infrastructure', emoji: '\uD83D\uDD28', mode: 'on-demand', heartbeat_interval: 'none' },
  { id: 'strategist', name: 'Strategist', role: 'Content Strategy & Social Intelligence', emoji: '\uD83D\uDCC8', mode: 'active', heartbeat_interval: '6h' },
]

/** @deprecated Use MATTEI_SYSTEMS_AGENTS instead. Kept for backwards compatibility. */
export const DEFAULT_AGENTS = MATTEI_SYSTEMS_AGENTS

export const CLAUDEPAW_AGENTS: AgentDef[] = [
  { id: 'builder', name: 'Builder', role: 'Platform Developer', emoji: '\uD83D\uDD28', mode: 'on-demand', heartbeat_interval: 'none' },
  { id: 'qa', name: 'QA', role: 'Testing & Quality', emoji: '\u2705', mode: 'on-demand', heartbeat_interval: 'none' },
  { id: 'docs', name: 'Docs', role: 'Documentation Maintainer', emoji: '\uD83D\uDCDD', mode: 'on-demand', heartbeat_interval: 'none' },
  { id: 'community', name: 'Community', role: 'OSS Community Manager', emoji: '\uD83E\uDD1D', mode: 'active', heartbeat_interval: '4h' },
  { id: 'scout', name: 'Scout', role: 'Competitive & Ecosystem Researcher', emoji: '\uD83D\uDD0D', mode: 'active', heartbeat_interval: '4h' },
  { id: 'maintainer', name: 'Maintainer', role: 'OSS Repo Maintainer', emoji: '\uD83D\uDEE0\uFE0F', mode: 'active', heartbeat_interval: '4h' },
  { id: 'advocate', name: 'Advocate', role: 'Platform Decision Challenger', emoji: '\uD83D\uDE08', mode: 'on-demand', heartbeat_interval: 'none' },
]

export const GENERIC_PROJECT_AGENTS: AgentDef[] = [
  { id: 'builder', name: 'Builder', role: 'Code & Infrastructure', emoji: '\uD83D\uDD28', mode: 'on-demand', heartbeat_interval: 'none' },
  { id: 'scout', name: 'Scout', role: 'Research & Intelligence', emoji: '\uD83D\uDD0D', mode: 'active', heartbeat_interval: '4h' },
  { id: 'strategist', name: 'Strategist', role: 'Strategy & Planning', emoji: '\uD83D\uDCC8', mode: 'active', heartbeat_interval: '6h' },
  { id: 'auditor', name: 'Auditor', role: 'Security Auditor', emoji: '\uD83D\uDEE1\uFE0F', mode: 'active', heartbeat_interval: '4h' },
  { id: 'advocate', name: 'Advocate', role: "Devil's Advocate", emoji: '\uD83D\uDE08', mode: 'on-demand', heartbeat_interval: 'none' },
]

/** Get the agent roster for a given project. Unknown projects get the generic roster. */
export function getAgentsForProject(projectId: string): AgentDef[] {
  switch (projectId) {
    case 'default': return PERSONAL_AGENTS
    case 'claudepaw': return CLAUDEPAW_AGENTS
    case 'default': return MATTEI_SYSTEMS_AGENTS
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
