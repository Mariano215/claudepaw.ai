import { describe, it, expect } from 'vitest'
import { renderDailyHtml } from './daily-html.js'
import type { ReportData } from './types.js'
import { fixture } from './digest-fixture.js'

describe('renderDailyHtml', () => {
  const html = renderDailyHtml(fixture as ReportData)

  it('renders the needs-you card first, above the status banner', () => {
    expect(html.indexOf('Needs you')).toBeGreaterThan(-1)
    expect(html.indexOf('Needs you')).toBeLessThan(html.indexOf('System Status'))
  })

  it('links every needs-you row to its dashboard page', () => {
    expect(html).toContain('href="http://dash/#paws"')
    expect(html).toContain('href="http://dash/#action-plan"')
  })

  // Spec 5.2: every row links to the dashboard, not only the needs-you rows.
  it('links a row in each of handled, spend and failures', () => {
    const withFailures = renderDailyHtml({
      ...fixture,
      paws: { ...fixture.paws, failed_cycles_24h: [{ paw_id: 'fo-festival-tracker', cycle_id: 'cy-1', failed_at: 1, error: 'feed timeout' }] },
      scheduled_tasks: { ...fixture.scheduled_tasks, failures_24h: [{ id: 'daily-backup', project_id: 'claudepaw', last_run: 1, error: 'git push refused' }] },
    } as ReportData)

    // Handled row: the project name itself is the link.
    expect(withFailures).toContain('href="http://dash/#dashboard"')
    expect(withFailures).toContain('>trader</a>')
    // Spend row and both failure rows point at the Inbox page.
    expect(withFailures).toContain('>fo-festival-tracker</a>')
    expect(withFailures).toContain('>daily-backup</a>')
    expect(withFailures.match(/href="http:\/\/dash\/#usage"/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('renders one handled-without-you row per project', () => {
    expect(html).toContain('trader')
    expect(html).toContain('default')
    expect(html).toContain('3 cron tasks ran, 2 cards shipped')
  })

  it('renders the handled section even when nothing ran', () => {
    const quiet = renderDailyHtml({ ...fixture, per_project: [] } as ReportData)
    expect(quiet).toContain('Handled without you')
    expect(quiet).toContain('Nothing ran.')
  })

  it('escapes titles so a card title cannot inject markup', () => {
    const evil = { ...fixture, needs_you: [{ ...fixture.needs_you[0], title: '<script>x</script>' }] }
    expect(renderDailyHtml(evil as ReportData)).not.toContain('<script>x</script>')
  })

  it('omits This week on the daily report (C6)', () => {
    expect(html).not.toContain('This week')
  })

  it('renders This week on the weekly report, in spec order before Spend', () => {
    const weekly = renderDailyHtml({ ...fixture, period: { ...fixture.period, hours: 168, label: 'Weekly' } } as ReportData)
    expect(weekly.indexOf('Handled without you')).toBeLessThan(weekly.indexOf('This week'))
    expect(weekly.indexOf('This week')).toBeLessThan(weekly.indexOf('Cost &amp; Usage'))
    expect(weekly).toContain('Routine cycles: 2. Cron tasks ran: 4. Cards shipped: 3.')
  })
})
