import { CREDENTIAL_ENCRYPTION_KEY } from '../../config.js'
import { IntegrationEngine } from '../../integrations/engine.js'
import { GoogleClient } from '../../integrations/google/client.js'
import { GmailModule } from '../../integrations/google/gmail.js'
import { CalendarModule } from '../../integrations/google/calendar.js'
import { SheetsModule } from '../../integrations/google/sheets.js'
import { googleManifest } from '../../integrations/google/manifest.js'

const PROJECT_ID = 'example-company'
const GOOGLE_ACCOUNT = 'your-account@example.com'

const SOCIAL_MEDIA_DATA_SHEET = 'YOUR_SHEET_ID_HERE'
const STRATEGY_SHEET = 'YOUR_SHEET_ID_HERE'
const EVELYN_FESTIVAL_SHEET = 'YOUR_SHEET_ID_HERE'

let engine: IntegrationEngine | null = null

function getEngine(): IntegrationEngine {
  if (!engine) {
    engine = new IntegrationEngine(CREDENTIAL_ENCRYPTION_KEY)
    engine.register(googleManifest)
  }
  return engine
}

function getGoogleClient(): GoogleClient {
  return new GoogleClient(
    getEngine(),
    process.env.GOOGLE_CLIENT_ID || '',
    process.env.GOOGLE_CLIENT_SECRET || '',
  )
}

function truncate(value: string, max = 280): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`
}

function formatTable(rows: string[][], maxRows = 8): string {
  if (!rows.length) return '(no rows)'
  return rows
    .slice(0, maxRows)
    .map((row) => `- ${row.map((cell) => (cell || '').trim()).join(' | ')}`)
    .join('\n')
}

type ContextResult = { label: string; content: string }

async function withGoogleAuth(): Promise<InstanceType<typeof import('googleapis').google.auth.OAuth2>> {
  const client = getGoogleClient()
  return await client.ensureFreshToken(PROJECT_ID, GOOGLE_ACCOUNT)
}

async function buildBriefingContext(): Promise<string> {
  const auth = await withGoogleAuth()
  const gmail = new GmailModule()
  const calendar = new CalendarModule()
  const now = new Date()
  const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)

  const sections: ContextResult[] = []

  const labels = await gmail.listLabels(auth)
  sections.push({
    label: 'Gmail Connectivity',
    content: `Connected labels sample: ${labels.slice(0, 8).map((label) => label.name).join(', ') || '(none)'}`,
  })

  const messages = await gmail.search(
    auth,
    'newer_than:7d (festival OR grant OR screenplay OR investor OR producer OR press OR Example Film OR "Example Project")',
    { maxResults: 10 },
  )
  sections.push({
    label: 'Recent Relevant Emails',
    content: messages.length === 0
      ? '(no matching messages in the last 7 days)'
      : messages.map((message) => (
          `- ${truncate(message.date || '(no date)', 80)} | ${truncate(message.from || '(no sender)', 80)} | ${truncate(message.subject || '(no subject)', 120)}`
        )).join('\n'),
  })

  const events = await calendar.list(
    auth,
    'primary',
    now.toISOString(),
    in14Days.toISOString(),
  )
  sections.push({
    label: 'Upcoming Calendar Events',
    content: events.length === 0
      ? '(no upcoming events in the next 14 days)'
      : events.slice(0, 12).map((event) => (
          `- ${event.start} -> ${event.end} | ${truncate(event.summary || '(untitled)', 120)}${event.location ? ` | ${truncate(event.location, 80)}` : ''}`
        )).join('\n'),
  })

  return [
    '## Structured Google Context',
    ...sections.flatMap((section) => [`### ${section.label}`, section.content, '']),
    'Use the structured context above as the source of truth for Gmail and calendar. Do not rerun CLI commands for those services.',
  ].join('\n')
}

async function buildContentPlanContext(): Promise<string> {
  const auth = await withGoogleAuth()
  const sheets = new SheetsModule()

  const analyticsMeta = await sheets.metadata(auth, SOCIAL_MEDIA_DATA_SHEET)
  const analyticsDashboard = await sheets.read(auth, SOCIAL_MEDIA_DATA_SHEET, 'Dashboard!A1:H20')
  const analyticsRecommendations = await sheets.read(auth, SOCIAL_MEDIA_DATA_SHEET, 'Analysis & Recommendations!A1:H20')
  const analyticsCalendar = await sheets.read(auth, SOCIAL_MEDIA_DATA_SHEET, 'Content Calendar!A1:H20')

  const strategyMeta = await sheets.metadata(auth, STRATEGY_SHEET)
  const strategyNow = await sheets.read(auth, STRATEGY_SHEET, 'NOW!A1:H20')
  const strategyPress = await sheets.read(auth, STRATEGY_SHEET, 'PRESS_OUTREACH!A1:H20')

  return [
    '## Structured Google Context',
    `Analytics workbook: ${analyticsMeta.title} (${analyticsMeta.sheets.map((sheet) => sheet.title).join(', ')})`,
    '### Analytics Dashboard Sample',
    formatTable(analyticsDashboard),
    '',
    '### Analytics Recommendations Sample',
    formatTable(analyticsRecommendations),
    '',
    '### Content Calendar Sample',
    formatTable(analyticsCalendar),
    '',
    `Strategy workbook: ${strategyMeta.title} (${strategyMeta.sheets.map((sheet) => sheet.title).join(', ')})`,
    '### NOW Sheet Sample',
    formatTable(strategyNow),
    '',
    '### Press Outreach Sample',
    formatTable(strategyPress),
    '',
    'Use the structured context above as the source of truth for Google Sheets. Do not rerun CLI commands for sheet access.',
  ].join('\n')
}

async function buildFestivalScanContext(): Promise<string> {
  const auth = await withGoogleAuth()
  const sheets = new SheetsModule()
  const festivalMeta = await sheets.metadata(auth, EVELYN_FESTIVAL_SHEET)
  const festivalRows = await sheets.read(auth, EVELYN_FESTIVAL_SHEET, 'Example Film Festival List!A1:J20')

  return [
    '## Structured Google Context',
    `Festival workbook: ${festivalMeta.title} (${festivalMeta.sheets.map((sheet) => sheet.title).join(', ')})`,
    '### Existing Festival Tracker Sample',
    formatTable(festivalRows, 12),
    '',
    'Use the structured context above to avoid duplicate festival recommendations. Do not rerun CLI commands for the spreadsheet.',
  ].join('\n')
}

export async function buildExampleCompanyTaskContext(taskId: string): Promise<string | null> {
  if (taskId === 'fop-weekly-briefing') return await buildBriefingContext()
  if (taskId === 'fop-weekly-content-plan') return await buildContentPlanContext()
  if (taskId === 'fop-weekly-festival-scan') return await buildFestivalScanContext()
  return null
}
