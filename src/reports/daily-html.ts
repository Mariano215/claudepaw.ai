// src/reports/daily-html.ts
//
// Email-safe HTML renderer for the daily usage report.
// Uses inline styles and table layout so it renders correctly in Gmail,
// Apple Mail, Outlook, mobile clients. No external CSS, no web fonts, no JS.

import type { ReportData, ProjectCost, PawFailure, TaskFailure, TopAgent, Anomaly, RemediationRow } from './types.js'

const COLORS = {
  bg: '#0e1220',
  bgSoft: '#151a2b',
  bgCard: '#1c2135',
  border: '#2a3150',
  text: '#e8ecf8',
  textMuted: '#9aa2bf',
  accent: '#f97316', // orange (claudepaw theme)
  accentSoft: '#7c5cff',
  green: '#22c55e',
  yellow: '#eab308',
  red: '#ef4444',
  headerBand: '#6366f1',
}

function escapeHtml(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return ''
  const str = String(s)
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtMoney(n: number): string {
  if (n < 0.005) return '$0.00'
  if (n < 1) return '$' + n.toFixed(3)
  return '$' + n.toFixed(2)
}

function fmtNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(Math.round(n))
}

function fmtDurationMs(ms: number): string {
  if (!ms || ms < 0) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

function fmtTimestamp(ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function deltaBadge(today: number, yesterday: number): string {
  if (yesterday === 0 && today === 0) return ''
  if (yesterday === 0) return `<span style="color:${COLORS.yellow};font-weight:600;">new</span>`
  const pct = ((today - yesterday) / yesterday) * 100
  if (Math.abs(pct) < 5) {
    return `<span style="color:${COLORS.textMuted};">±${Math.abs(pct).toFixed(0)}%</span>`
  }
  const color = pct > 0 ? COLORS.red : COLORS.green
  const arrow = pct > 0 ? '▲' : '▼'
  return `<span style="color:${color};font-weight:600;">${arrow} ${Math.abs(pct).toFixed(0)}%</span>`
}

function statusBanner(data: ReportData): string {
  const statusColor =
    data.overall_status === 'green' ? COLORS.green :
    data.overall_status === 'yellow' ? COLORS.yellow : COLORS.red

  const statusLabel =
    data.overall_status === 'green' ? 'All systems healthy' :
    data.overall_status === 'yellow' ? 'Needs attention' : 'Issues detected'

  const dot = `<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${statusColor};vertical-align:middle;margin-right:10px;box-shadow:0 0 12px ${statusColor};"></span>`

  const issues = data.overall_issues.length
    ? `<div style="margin-top:10px;color:${COLORS.textMuted};font-size:13px;">${data.overall_issues.map(escapeHtml).join(' &nbsp;•&nbsp; ')}</div>`
    : ''

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bgCard};border:1px solid ${statusColor};border-radius:12px;margin-bottom:20px;">
  <tr>
    <td style="padding:20px 24px;">
      <div style="font-size:11px;letter-spacing:1.5px;color:${COLORS.textMuted};text-transform:uppercase;margin-bottom:6px;">System Status</div>
      <div style="font-size:22px;font-weight:700;color:${COLORS.text};">${dot}${statusLabel}</div>
      ${issues}
    </td>
  </tr>
</table>`
}

function costCard(data: ReportData): string {
  const { cost } = data
  const rows = cost.per_project.map(renderProjectCostRow).join('')
  const deltaLabel = deltaBadge(cost.today_usd, cost.yesterday_usd)

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bgCard};border:1px solid ${COLORS.border};border-radius:12px;margin-bottom:20px;">
  <tr>
    <td style="padding:18px 24px;border-bottom:1px solid ${COLORS.border};">
      <div style="font-size:11px;letter-spacing:1.5px;color:${COLORS.textMuted};text-transform:uppercase;">Cost &amp; Usage</div>
    </td>
  </tr>
  <tr>
    <td style="padding:20px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="33%" style="padding-right:12px;">
            <div style="font-size:11px;color:${COLORS.textMuted};text-transform:uppercase;letter-spacing:1px;">Today</div>
            <div style="font-size:26px;font-weight:700;color:${COLORS.text};">${fmtMoney(cost.today_usd)}</div>
            <div style="font-size:12px;margin-top:4px;">${deltaLabel} <span style="color:${COLORS.textMuted};">vs yesterday ${fmtMoney(cost.yesterday_usd)}</span></div>
          </td>
          <td width="33%" style="padding:0 12px;border-left:1px solid ${COLORS.border};">
            <div style="font-size:11px;color:${COLORS.textMuted};text-transform:uppercase;letter-spacing:1px;">Month to date</div>
            <div style="font-size:26px;font-weight:700;color:${COLORS.text};">${fmtMoney(cost.mtd_usd)}</div>
            <div style="font-size:12px;margin-top:4px;color:${COLORS.textMuted};">${cost.mtd_cap ? `cap ${fmtMoney(cost.mtd_cap)}` : 'no cap set'}</div>
          </td>
          <td width="34%" style="padding-left:12px;border-left:1px solid ${COLORS.border};">
            <div style="font-size:11px;color:${COLORS.textMuted};text-transform:uppercase;letter-spacing:1px;">Calls (24h)</div>
            <div style="font-size:26px;font-weight:700;color:${COLORS.text};">${fmtNumber(data.agent_events.total_24h)}</div>
            <div style="font-size:12px;margin-top:4px;color:${data.agent_events.errors_24h ? COLORS.red : COLORS.textMuted};">${data.agent_events.errors_24h} errors</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  ${cost.per_project.length > 0 ? `
  <tr>
    <td style="padding:0 24px 20px;">
      <div style="font-size:12px;color:${COLORS.textMuted};text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">By Project</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">
        <thead>
          <tr style="color:${COLORS.textMuted};text-align:left;">
            <th style="padding:6px 0;font-weight:500;">Project</th>
            <th style="padding:6px 0;font-weight:500;text-align:right;">Today</th>
            <th style="padding:6px 0;font-weight:500;text-align:right;">MTD</th>
            <th style="padding:6px 0;font-weight:500;text-align:right;">Cap Usage</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </td>
  </tr>` : ''}
</table>`
}

function renderProjectCostRow(p: ProjectCost): string {
  const capBar = p.pct_of_cap === null
    ? `<span style="color:${COLORS.textMuted};font-size:12px;">no cap</span>`
    : renderCapBar(p.pct_of_cap, p.action)
  return `
  <tr style="border-top:1px solid ${COLORS.border};color:${COLORS.text};">
    <td style="padding:10px 0;">${escapeHtml(p.project_id)}</td>
    <td style="padding:10px 0;text-align:right;font-variant-numeric:tabular-nums;">${fmtMoney(p.today)}</td>
    <td style="padding:10px 0;text-align:right;font-variant-numeric:tabular-nums;">${fmtMoney(p.mtd)}</td>
    <td style="padding:10px 0;text-align:right;">${capBar}</td>
  </tr>`
}

function renderCapBar(pct: number, action: string): string {
  const clamped = Math.min(100, Math.max(0, pct))
  const barColor =
    action === 'blocked' ? COLORS.red :
    action === 'ollama' ? COLORS.red :
    clamped >= 80 ? COLORS.yellow :
    COLORS.green
  return `
    <span style="display:inline-block;vertical-align:middle;width:120px;height:8px;background:${COLORS.border};border-radius:4px;overflow:hidden;">
      <span style="display:inline-block;width:${clamped}%;height:100%;background:${barColor};"></span>
    </span>
    <span style="margin-left:8px;font-variant-numeric:tabular-nums;color:${barColor};font-weight:600;">${pct.toFixed(0)}%</span>`
}

function killSwitchCard(data: ReportData): string {
  if (!data.kill_switch.active) return ''
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#3a0d10;border:2px solid ${COLORS.red};border-radius:12px;margin-bottom:20px;">
  <tr>
    <td style="padding:20px 24px;">
      <div style="font-size:12px;letter-spacing:1.5px;color:${COLORS.red};text-transform:uppercase;font-weight:700;">⚠ Kill Switch Active</div>
      <div style="font-size:18px;font-weight:700;color:${COLORS.text};margin-top:8px;">All agent execution is halted</div>
      <div style="font-size:13px;color:${COLORS.textMuted};margin-top:6px;">
        ${data.kill_switch.reason ? `Reason: ${escapeHtml(data.kill_switch.reason)}` : ''}
        ${data.kill_switch.set_at ? ` &nbsp;•&nbsp; Tripped ${fmtTimestamp(data.kill_switch.set_at)}` : ''}
        ${data.kill_switch.set_by ? ` &nbsp;•&nbsp; by ${escapeHtml(data.kill_switch.set_by)}` : ''}
      </div>
    </td>
  </tr>
</table>`
}

function pawsCard(data: ReportData): string {
  const { paws } = data
  const badges = `
    <span style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${COLORS.green}22;color:${COLORS.green};margin-right:6px;">${paws.active} active</span>
    <span style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${paws.waiting_approval > 0 ? COLORS.yellow + '22' : COLORS.border};color:${paws.waiting_approval > 0 ? COLORS.yellow : COLORS.textMuted};margin-right:6px;">${paws.waiting_approval} waiting approval</span>
    <span style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;background:${paws.paused > 0 ? COLORS.textMuted + '22' : COLORS.border};color:${COLORS.textMuted};">${paws.paused} paused</span>`

  const failures = paws.failed_cycles_24h.length > 0
    ? `<div style="margin-top:14px;border-top:1px solid ${COLORS.border};padding-top:14px;">
        <div style="font-size:12px;color:${COLORS.red};text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Failed cycles (last 24h)</div>
        ${paws.failed_cycles_24h.map(renderPawFailure).join('')}
       </div>`
    : ''

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bgCard};border:1px solid ${COLORS.border};border-radius:12px;margin-bottom:20px;">
  <tr>
    <td style="padding:18px 24px;border-bottom:1px solid ${COLORS.border};">
      <div style="font-size:11px;letter-spacing:1.5px;color:${COLORS.textMuted};text-transform:uppercase;">Paws Health</div>
    </td>
  </tr>
  <tr>
    <td style="padding:20px 24px;">
      <div>${badges}</div>
      ${failures}
    </td>
  </tr>
</table>`
}

function renderPawFailure(f: PawFailure): string {
  return `
    <div style="background:${COLORS.bgSoft};padding:10px 14px;border-radius:8px;margin-bottom:8px;border-left:3px solid ${COLORS.red};">
      <div style="font-size:13px;color:${COLORS.text};font-weight:600;">${escapeHtml(f.paw_id)}</div>
      <div style="font-size:12px;color:${COLORS.textMuted};margin-top:3px;">${fmtTimestamp(f.failed_at)}</div>
      <div style="font-size:12px;color:${COLORS.textMuted};margin-top:5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(f.error.slice(0, 200))}${f.error.length > 200 ? '...' : ''}</div>
    </div>`
}

function tasksCard(data: ReportData): string {
  const { scheduled_tasks } = data
  if (scheduled_tasks.failures_24h.length === 0 && scheduled_tasks.total_active === 0) return ''

  const failures = scheduled_tasks.failures_24h.length > 0
    ? `<div style="margin-top:14px;">
        <div style="font-size:12px;color:${COLORS.yellow};text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Failures (last 24h)</div>
        ${scheduled_tasks.failures_24h.map(renderTaskFailure).join('')}
       </div>`
    : `<div style="color:${COLORS.textMuted};font-size:13px;">No scheduled task failures in the last 24h.</div>`

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bgCard};border:1px solid ${COLORS.border};border-radius:12px;margin-bottom:20px;">
  <tr>
    <td style="padding:18px 24px;border-bottom:1px solid ${COLORS.border};">
      <div style="font-size:11px;letter-spacing:1.5px;color:${COLORS.textMuted};text-transform:uppercase;">Scheduled Tasks</div>
    </td>
  </tr>
  <tr>
    <td style="padding:20px 24px;">
      <div style="color:${COLORS.text};font-size:14px;">${scheduled_tasks.total_active} active</div>
      ${failures}
    </td>
  </tr>
</table>`
}

function renderTaskFailure(f: TaskFailure): string {
  return `
    <div style="background:${COLORS.bgSoft};padding:10px 14px;border-radius:8px;margin-bottom:8px;border-left:3px solid ${COLORS.yellow};">
      <div style="font-size:13px;color:${COLORS.text};font-weight:600;">${escapeHtml(f.id)}</div>
      <div style="font-size:12px;color:${COLORS.textMuted};margin-top:3px;">${escapeHtml(f.project_id)} &nbsp;•&nbsp; ${fmtTimestamp(f.last_run)}</div>
      <div style="font-size:12px;color:${COLORS.textMuted};margin-top:5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(f.error.slice(0, 200))}${f.error.length > 200 ? '...' : ''}</div>
    </div>`
}

function providersCard(data: ReportData): string {
  const { agent_events } = data
  if (agent_events.by_provider.length === 0) return ''
  const rows = agent_events.by_provider
    .map(p => {
      const errPct = p.count > 0 ? (p.errors / p.count) * 100 : 0
      const errColor = p.errors === 0 ? COLORS.textMuted : errPct > 10 ? COLORS.red : COLORS.yellow
      return `
        <tr style="border-top:1px solid ${COLORS.border};color:${COLORS.text};">
          <td style="padding:10px 0;">${escapeHtml(p.provider)}</td>
          <td style="padding:10px 0;text-align:right;font-variant-numeric:tabular-nums;">${fmtNumber(p.count)}</td>
          <td style="padding:10px 0;text-align:right;color:${errColor};font-variant-numeric:tabular-nums;">${p.errors} ${p.count > 0 ? `(${errPct.toFixed(1)}%)` : ''}</td>
        </tr>`
    })
    .join('')

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bgCard};border:1px solid ${COLORS.border};border-radius:12px;margin-bottom:20px;">
  <tr>
    <td style="padding:18px 24px;border-bottom:1px solid ${COLORS.border};">
      <div style="font-size:11px;letter-spacing:1.5px;color:${COLORS.textMuted};text-transform:uppercase;">Execution Providers</div>
      <div style="font-size:12px;color:${COLORS.textMuted};margin-top:4px;">Avg duration ${fmtDurationMs(agent_events.avg_duration_ms)}</div>
    </td>
  </tr>
  <tr>
    <td style="padding:0 24px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">
        <thead>
          <tr style="color:${COLORS.textMuted};text-align:left;">
            <th style="padding:10px 0 6px;font-weight:500;">Provider</th>
            <th style="padding:10px 0 6px;font-weight:500;text-align:right;">Calls</th>
            <th style="padding:10px 0 6px;font-weight:500;text-align:right;">Errors</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </td>
  </tr>
</table>`
}

function topAgentsCard(data: ReportData): string {
  const { top_agents } = data.agent_events
  if (top_agents.length === 0) return ''
  const rows = top_agents
    .map(a => `
      <tr style="border-top:1px solid ${COLORS.border};color:${COLORS.text};">
        <td style="padding:10px 0;">${escapeHtml(a.agent_id || 'unknown')}</td>
        <td style="padding:10px 0;text-align:right;font-variant-numeric:tabular-nums;">${fmtNumber(a.calls)}</td>
        <td style="padding:10px 0;text-align:right;font-variant-numeric:tabular-nums;">${fmtMoney(a.cost_usd)}</td>
        <td style="padding:10px 0;text-align:right;color:${a.errors > 0 ? COLORS.red : COLORS.textMuted};">${a.errors}</td>
      </tr>`)
    .join('')

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bgCard};border:1px solid ${COLORS.border};border-radius:12px;margin-bottom:20px;">
  <tr>
    <td style="padding:18px 24px;border-bottom:1px solid ${COLORS.border};">
      <div style="font-size:11px;letter-spacing:1.5px;color:${COLORS.textMuted};text-transform:uppercase;">Top Agents (by spend, 24h)</div>
    </td>
  </tr>
  <tr>
    <td style="padding:0 24px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">
        <thead>
          <tr style="color:${COLORS.textMuted};text-align:left;">
            <th style="padding:10px 0 6px;font-weight:500;">Agent</th>
            <th style="padding:10px 0 6px;font-weight:500;text-align:right;">Calls</th>
            <th style="padding:10px 0 6px;font-weight:500;text-align:right;">Cost</th>
            <th style="padding:10px 0 6px;font-weight:500;text-align:right;">Errors</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </td>
  </tr>
</table>`
}

function topToolsCard(data: ReportData): string {
  const tools = data.agent_events.top_tools ?? []
  if (tools.length === 0) return ''
  const rows = tools
    .map(t => `
      <tr style="border-top:1px solid ${COLORS.border};color:${COLORS.text};">
        <td style="padding:10px 0;">${escapeHtml(t.tool_name)}</td>
        <td style="padding:10px 0;text-align:right;font-variant-numeric:tabular-nums;">${fmtNumber(t.calls)}</td>
        <td style="padding:10px 0;text-align:right;color:${t.failures > 0 ? COLORS.red : COLORS.textMuted};">${t.failures}</td>
      </tr>`)
    .join('')
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bgCard};border:1px solid ${COLORS.border};border-radius:12px;margin-bottom:20px;">
  <tr>
    <td style="padding:18px 24px;border-bottom:1px solid ${COLORS.border};">
      <div style="font-size:11px;letter-spacing:1.5px;color:${COLORS.textMuted};text-transform:uppercase;">Top Tools (by calls, ${escapeHtml(data.period.label)})</div>
    </td>
  </tr>
  <tr>
    <td style="padding:0 24px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">
        <thead>
          <tr style="color:${COLORS.textMuted};text-align:left;">
            <th style="padding:10px 0 6px;font-weight:500;">Tool</th>
            <th style="padding:10px 0 6px;font-weight:500;text-align:right;">Calls</th>
            <th style="padding:10px 0 6px;font-weight:500;text-align:right;">Failures</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </td>
  </tr>
</table>`
}

function remediationsCard(data: ReportData): string {
  const items = data.remediations_24h ?? []
  if (items.length === 0) {
    return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bgCard};border:1px solid ${COLORS.border};border-radius:12px;margin-bottom:20px;">
  <tr>
    <td style="padding:18px 24px;border-bottom:1px solid ${COLORS.border};">
      <div style="font-size:11px;letter-spacing:1.5px;color:${COLORS.textMuted};text-transform:uppercase;">Auto-Remediations</div>
    </td>
  </tr>
  <tr>
    <td style="padding:18px 24px;color:${COLORS.textMuted};font-size:13px;">
      No auto-fixes applied in the last 24h.
    </td>
  </tr>
</table>`
  }

  const rows = items.map(renderRemediation).join('')
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bgCard};border:1px solid ${COLORS.border};border-radius:12px;margin-bottom:20px;">
  <tr>
    <td style="padding:18px 24px;border-bottom:1px solid ${COLORS.border};">
      <div style="font-size:11px;letter-spacing:1.5px;color:${COLORS.textMuted};text-transform:uppercase;">Auto-Remediations (last 24h)</div>
      <div style="font-size:12px;color:${COLORS.textMuted};margin-top:4px;">${items.length} ${items.length === 1 ? 'fix' : 'fixes'} applied</div>
    </td>
  </tr>
  <tr>
    <td style="padding:18px 24px;">${rows}</td>
  </tr>
</table>`
}

function renderRemediation(r: RemediationRow): string {
  return `
    <div style="background:${COLORS.bgSoft};padding:10px 14px;border-radius:8px;margin-bottom:8px;border-left:3px solid ${COLORS.accent};">
      <div style="font-size:13px;color:${COLORS.text};font-weight:600;">${escapeHtml(r.remediation_id)}</div>
      <div style="font-size:12px;color:${COLORS.textMuted};margin-top:3px;">${fmtTimestamp(r.started_at)}</div>
      <div style="font-size:12px;color:${COLORS.text};margin-top:5px;">${escapeHtml(r.summary)}</div>
    </div>`
}

function anomaliesCard(data: ReportData): string {
  if (data.anomalies.length === 0) return ''
  const rows = data.anomalies.map(renderAnomaly).join('')
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bgCard};border:1px solid ${COLORS.border};border-radius:12px;margin-bottom:20px;">
  <tr>
    <td style="padding:18px 24px;border-bottom:1px solid ${COLORS.border};">
      <div style="font-size:11px;letter-spacing:1.5px;color:${COLORS.textMuted};text-transform:uppercase;">Anomalies</div>
    </td>
  </tr>
  <tr>
    <td style="padding:18px 24px;">${rows}</td>
  </tr>
</table>`
}

function renderAnomaly(a: Anomaly): string {
  const color = a.level === 'crit' ? COLORS.red : a.level === 'warn' ? COLORS.yellow : COLORS.textMuted
  return `
    <div style="padding:10px 0;border-top:1px solid ${COLORS.border};color:${COLORS.text};font-size:13px;">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:10px;vertical-align:middle;"></span>${escapeHtml(a.message)}
    </div>`
}

export function renderDailyHtml(data: ReportData): string {
  const generated = fmtTimestamp(data.generated_at)
  const periodLabel = data.period.label
  const dashboardUrl = data.dashboard_url || 'http://localhost:3000/#dashboard'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClaudePaw Daily Report</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${COLORS.text};">
<div style="max-width:640px;margin:0 auto;padding:28px 20px;">

  <!-- Header band -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
    <tr>
      <td>
        <div style="font-size:11px;letter-spacing:2px;color:${COLORS.accent};text-transform:uppercase;font-weight:600;">ClaudePaw</div>
        <div style="font-size:24px;font-weight:700;color:${COLORS.text};margin-top:6px;">Daily Usage Report</div>
        <div style="font-size:13px;color:${COLORS.textMuted};margin-top:4px;">${escapeHtml(periodLabel)} &nbsp;•&nbsp; Generated ${escapeHtml(generated)}</div>
      </td>
    </tr>
  </table>

  ${killSwitchCard(data)}
  ${statusBanner(data)}
  ${costCard(data)}
  ${pawsCard(data)}
  ${tasksCard(data)}
  ${providersCard(data)}
  ${topAgentsCard(data)}
  ${topToolsCard(data)}
  ${remediationsCard(data)}
  ${anomaliesCard(data)}

  <!-- Footer -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:30px;">
    <tr>
      <td style="padding:20px 0;border-top:1px solid ${COLORS.border};text-align:center;font-size:12px;color:${COLORS.textMuted};">
        <div>
          <a href="${escapeHtml(dashboardUrl)}" style="color:${COLORS.accent};text-decoration:none;font-weight:600;">Open dashboard</a>
          &nbsp;•&nbsp;
          <span>To pause this report: <code style="background:${COLORS.bgCard};padding:2px 6px;border-radius:4px;color:${COLORS.text};">DAILY_REPORT_ENABLED=false</code> in .env</span>
        </div>
        <div style="margin-top:8px;">To switch to weekly: <code style="background:${COLORS.bgCard};padding:2px 6px;border-radius:4px;color:${COLORS.text};">DAILY_REPORT_PERIOD_HOURS=168</code></div>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`
}
