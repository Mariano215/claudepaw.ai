// The Telegram half of the daily digest. Same ReportData as the email, plain
// text only: no markdown markers, no HTML tags, no entity codes (CLAUDE.md,
// "Telegram: plain text only").
import type { ReportData, NeedsYouItem } from './types.js'
import { age, money } from './format.js'

/** A decision older than this gets one nudge before the 48h auto-skip. */
const REMINDER_MS = 12 * 3_600_000

function needsYouLine(item: NeedsYouItem): string {
  return `- ${item.title} (${item.project_id}, ${age(item.age_ms)}) ${item.url}`
}

export function renderDigestText(data: ReportData): string {
  const lines: string[] = []
  const weekly = data.period.hours >= 168

  lines.push(weekly ? 'ClaudePaw weekly digest' : 'ClaudePaw daily digest')
  lines.push(data.period.label)
  lines.push('')

  lines.push('Needs you')
  if (data.needs_you.length === 0) {
    lines.push('Nothing is waiting on you.')
  } else {
    const overdue = data.needs_you.filter(i => i.age_ms >= REMINDER_MS)
    const fresh = data.needs_you.filter(i => i.age_ms < REMINDER_MS)
    if (overdue.length > 0) {
      lines.push(`${overdue.length} waiting more than 12h, auto-skipped at 48h:`)
      for (const i of overdue) lines.push(needsYouLine(i))
    }
    for (const i of fresh) lines.push(needsYouLine(i))
  }
  lines.push('')

  lines.push('Handled without you')
  if (data.per_project.length === 0) {
    lines.push('Nothing ran.')
  } else {
    for (const p of data.per_project) lines.push(`- ${p.project_id}: ${p.note}`)
  }
  lines.push('')

  // C6: the weekly roll-up only, not every daily digest.
  if (weekly) {
    lines.push('This week')
    lines.push(
      `Routine cycles: ${data.per_project.reduce((n, p) => n + p.cycles, 0)}. ` +
      `Cron tasks ran: ${data.per_project.reduce((n, p) => n + p.cron_tasks_run, 0)}. ` +
      `Cards shipped: ${data.per_project.reduce((n, p) => n + p.cards_shipped, 0)}.`,
    )
    lines.push('')
  }

  lines.push('Spend')
  lines.push(
    `Today ${money(data.cost.today_usd)}. Month to date ${money(data.cost.mtd_usd)}` +
    `${data.cost.mtd_cap ? ` of ${money(data.cost.mtd_cap)}` : ''}.`,
  )
  lines.push('')

  lines.push('Failures')
  const failures = data.paws.failed_cycles_24h.length + data.scheduled_tasks.failures_24h.length
    + data.degraded_integrations.length
  if (failures === 0) {
    lines.push('None.')
  } else {
    for (const f of data.paws.failed_cycles_24h) lines.push(`- routine ${f.paw_id}: ${f.error.slice(0, 120)}`)
    for (const f of data.scheduled_tasks.failures_24h) lines.push(`- cron ${f.id}: ${f.error.slice(0, 120)}`)
    for (const d of data.degraded_integrations) {
      lines.push(`- ${d.platform} (${d.project_id}): ${d.status}, ${d.attempts} attempts${d.reason ? `, ${d.reason}` : ''}`)
    }
  }

  if (data.dashboard_url) {
    lines.push('')
    lines.push(`Dashboard: ${data.dashboard_url}`)
  }

  return lines.join('\n')
}
