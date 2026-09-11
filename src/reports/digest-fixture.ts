// One ReportData fixture shared by the email and Telegram digest renderer
// tests (R10), so both renderers are checked against the same input.
import type { ReportData } from './types.js'

export const fixture: ReportData = {
  generated_at: Date.parse('2026-09-10T12:00:00Z'),
  period: {
    hours: 24,
    from: Date.parse('2026-09-09T12:00:00Z'),
    to: Date.parse('2026-09-10T12:00:00Z'),
    label: 'Daily',
  },
  overall_status: 'yellow',
  overall_issues: ['trader approaching cap'],
  cost: {
    today_usd: 3.45,
    yesterday_usd: 2.1,
    mtd_usd: 41.2,
    mtd_cap: 100,
    per_project: [
      { project_id: 'trader', today: 2.9, mtd: 30, cap_monthly: 60, pct_of_cap: 50, action: 'allow' },
      { project_id: 'default', today: 0.55, mtd: 11.2, cap_monthly: null, pct_of_cap: null, action: 'allow' },
    ],
  },
  agent_sdk_pool: null,
  kill_switch: { active: false },
  paws: {
    total: 3,
    active: 2,
    paused: 0,
    waiting_approval: 1,
    failed_cycles_24h: [],
  },
  scheduled_tasks: {
    total_active: 4,
    failures_24h: [],
  },
  agent_events: {
    total_24h: 12,
    errors_24h: 1,
    by_provider: [{ provider: 'anthropic', count: 12, errors: 1 }],
    top_agents: [{ agent_id: 'analyst', calls: 5, cost_usd: 1.2, errors: 0 }],
    avg_duration_ms: 4200,
    top_tools: [],
  },
  anomalies: [{ level: 'warn', message: 'trader cost trending up' }],
  remediations_24h: [],
  needs_you: [
    {
      title: 'Routine waiting on you: Retrain regime',
      project_id: 'trader',
      kind: 'routine_approval',
      url: 'http://dash/#paws',
      age_ms: 2 * 86_400_000,
    },
    {
      title: 'Approve social.post',
      project_id: 'default',
      kind: 'card',
      url: 'http://dash/#action-plan',
      age_ms: 3600_000,
    },
  ],
  per_project: [
    { project_id: 'trader', cycles: 2, cron_tasks_run: 1, cards_opened: 1, cards_shipped: 1, cost_usd: 2.9, failures: 1, note: '2 routine cycles, 1 cron task ran, 1 card shipped, 1 failure' },
    { project_id: 'default', cycles: 0, cron_tasks_run: 3, cards_opened: 0, cards_shipped: 2, cost_usd: 0.55, failures: 0, note: '3 cron tasks ran, 2 cards shipped' },
  ],
  degraded_integrations: [],
  dashboard_url: 'http://dash/#dashboard',
}
