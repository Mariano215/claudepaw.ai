export const msSocialCadencePhaseInstructions = {
  observe:
    'Check ClaudePaw social posting cadence using the ClaudePaw DB as the source of truth for queue state.\n' +
    'Run via Bash:\n' +
    '1. sqlite3 ./store/claudepaw.db ".mode column" ".headers on" "SELECT platform, SUM(CASE WHEN status = \'published\' AND published_at >= strftime(\'%s\',\'now\',\'-7 days\') * 1000 THEN 1 ELSE 0 END) AS published_last_7d, datetime(MAX(CASE WHEN status = \'published\' THEN published_at END) / 1000, \'unixepoch\') AS last_published_utc, SUM(CASE WHEN status = \'approved\' AND scheduled_at IS NOT NULL AND scheduled_at <= strftime(\'%s\',\'now\') * 1000 THEN 1 ELSE 0 END) AS overdue_approved, datetime(MIN(CASE WHEN status = \'approved\' AND scheduled_at > strftime(\'%s\',\'now\') * 1000 THEN scheduled_at END) / 1000, \'unixepoch\') AS next_scheduled_utc FROM social_posts WHERE project_id = \'default\' AND platform IN (\'linkedin\',\'twitter\') GROUP BY platform"\n' +
    '2. sqlite3 ./store/claudepaw.db ".mode column" ".headers on" "SELECT id, platform, status, datetime(scheduled_at / 1000, \'unixepoch\') AS scheduled_utc, datetime(published_at / 1000, \'unixepoch\') AS published_utc, substr(error, 1, 120) AS error, substr(content, 1, 80) AS content FROM social_posts WHERE project_id = \'default\' AND platform IN (\'linkedin\',\'twitter\') ORDER BY COALESCE(published_at, scheduled_at, created_at) DESC LIMIT 20"\n' +
    '3. sqlite3 ./store/claudepaw.db ".mode column" ".headers on" "SELECT id, platform, datetime(scheduled_at / 1000, \'unixepoch\') AS scheduled_utc, substr(content, 1, 80) AS content FROM social_posts WHERE project_id = \'default\' AND platform IN (\'linkedin\',\'twitter\') AND status = \'approved\' AND scheduled_at IS NOT NULL AND scheduled_at <= strftime(\'%s\',\'now\') * 1000 ORDER BY scheduled_at ASC LIMIT 20"\n' +
    'Only use public platform checks as a secondary signal for posts older than 7 days. Do not treat generic web search or lack of search indexing as proof a post failed.\n' +
    'Output only the numbers and rows needed to decide whether the queue is healthy, queued, or stuck.',
  analyze:
    'Use published_at for cadence and scheduled_at for queue health.\n' +
    'Do NOT use created_at or approval timestamps as evidence that a post should already be live.\n' +
    'Rules:\n' +
    '- approved + scheduled_at in the future = queued, not stuck.\n' +
    '- approved + scheduled_at <= now = overdue queue item, possible publish failure.\n' +
    '- Lack of search-engine indexing alone is not a finding.\n' +
    '- If published_last_7d is 0 but next_scheduled_utc is within the next 72 hours and overdue_approved is 0, report queued/watch-next-slot rather than a cadence failure.\n' +
    'Targets:\n' +
    '- LinkedIn: at least 2 published posts per 7 days.\n' +
    '- X/Twitter: at least 3 published posts per 7 days.\n' +
    'Severity guide:\n' +
    '- overdue_approved > 0 or repeated failed rows = 4.\n' +
    '- 0 published in last 7 days and nothing queued in the next 72 hours = 3.\n' +
    '- rows with status=published but published_at IS NULL = 2 (data integrity gap; can mask silent publish failures).\n' +
    '- queued but not yet due = 1 informational only.\n' +
    'Finding quality gate (enforce strictly):\n' +
    '- Recommended action must be a concrete executable step, not an investigation. Bad: "verify which column". Good: "Run: SELECT id, status FROM social_posts WHERE status=\'published\' AND published_at IS NULL LIMIT 10".\n' +
    '- If the only honest recommended action is investigative and current impact is zero, suppress the finding. Do not emit severity 1 noise with no executable next step.\n' +
    'Only emit findings when there is a clear action or status change.\n' +
    'Hard cap: at most 2 findings total.\n' +
    'In each finding detail include: Target, Why it matters, Recommended action.\n' +
    'Target must be exactly one of: LINKEDIN, X, BOTH, NONE.\n' +
    'Mark is_new=true only when a new overdue queue or true cadence gap begins or worsens.',
  act: 'No automated actions. Cadence alerts are informational.',
  report:
    'Format:\n' +
    '- LinkedIn: published_last_7d [n], overdue approved [n], next scheduled [exact datetime from next_scheduled_utc, or "none" if NULL -- never write "see queue"]\n' +
    '- X/Twitter: published_last_7d [n], overdue approved [n], next scheduled [exact datetime from next_scheduled_utc, or "none" if NULL -- never write "see queue"]\n' +
    '- Overall: HEALTHY / QUEUED / NEEDS ATTENTION / STUCK\n' +
    '- Action: one sentence only\n\n' +
    'If approved posts are scheduled later today or later this week and overdue approved is 0, say the queue is staged correctly.\n' +
    'If everything is on track, say "Social cadence healthy -- queue aligned with schedule."',
} as const
