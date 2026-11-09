// src/reports/types.ts
// Shared shapes for the daily/weekly usage report.

export interface ProjectCost {
  project_id: string
  today: number
  mtd: number
  cap_monthly: number | null
  pct_of_cap: number | null
  action: 'allow' | 'warn' | 'ollama' | 'blocked'
}

export interface PawFailure {
  paw_id: string
  cycle_id: string
  error: string
  failed_at: number
}

export interface TaskFailure {
  id: string
  project_id: string
  last_run: number
  error: string
}

export interface TopAgent {
  agent_id: string
  calls: number
  cost_usd: number
  errors: number
}

export interface ProviderStat {
  provider: string
  count: number
  errors: number
}

export interface Anomaly {
  level: 'info' | 'warn' | 'crit'
  message: string
}

export interface RemediationRow {
  id: number
  remediation_id: string
  started_at: number
  completed_at: number
  acted: 0 | 1
  summary: string
}

export interface NeedsYouItem {
  title: string
  project_id: string
  kind: 'routine_approval' | 'card'
  url: string
  age_ms: number
}

export interface ProjectActivity {
  project_id: string
  cycles: number
  cron_tasks_run: number
  cards_opened: number
  cards_shipped: number
  cost_usd: number
  failures: number
  /** One line of what changed, rendered as-is in both renderers. */
  note: string
}

/** One integration the metric collector could not read. Source: the server
 *  metric_health table through GET /api/v1/metric-health/degraded. It replaces
 *  the metric-healer agent, whose only output was this same list in prose. */
export interface DegradedIntegration {
  integration_id: number
  project_id: string
  platform: string
  status: string
  attempts: number
  reason: string | null
}

export interface KillSwitchState {
  active: boolean
  reason?: string
  set_at?: number
  set_by?: string
}

export interface ReportData {
  generated_at: number
  period: { hours: number; from: number; to: number; label: string }
  overall_status: 'green' | 'yellow' | 'red'
  overall_issues: string[]
  cost: {
    today_usd: number
    yesterday_usd: number
    mtd_usd: number
    mtd_cap: number | null
    per_project: ProjectCost[]
  }
  /**
   * Anthropic Agent SDK Credit Pool snapshot for the daily/weekly digest.
   * Null when the pool gate is unavailable. Renderer hides the card cleanly
   * when null. Source: server cost-gate.ts computePoolGateStatus.
   */
  agent_sdk_pool?: {
    spend_usd: number
    cap_usd: number
    percent_of_pool: number
    projected_eom_usd: number
    action: 'allow' | 'override_to_ollama' | 'refuse'
    override_threshold_pct: number
    hardstop_threshold_pct: number
  } | null
  kill_switch: KillSwitchState
  paws: {
    total: number
    active: number
    paused: number
    waiting_approval: number
    failed_cycles_24h: PawFailure[]
  }
  scheduled_tasks: {
    total_active: number
    failures_24h: TaskFailure[]
  }
  agent_events: {
    total_24h: number
    errors_24h: number
    by_provider: ProviderStat[]
    top_agents: TopAgent[]
    avg_duration_ms: number
    /** Top tools by call count in the window (feature #17). Empty when no tools invoked. */
    top_tools: Array<{ tool_name: string; calls: number; failures: number }>
  }
  anomalies: Anomaly[]
  remediations_24h: RemediationRow[]
  needs_you: NeedsYouItem[]
  per_project: ProjectActivity[]
  degraded_integrations: DegradedIntegration[]
  dashboard_url?: string
}
