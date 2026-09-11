import { initDatabase } from '../src/db.js'
import { listActionItems } from '../src/db.js'
import { transitionActionItem } from '../src/action-items.js'
import { reportActionPlanSnapshot } from '../src/dashboard.js'
initDatabase()
const cutoff = new Date('2026-09-01T00:00:00-04:00').getTime()
const rows = listActionItems({ status: 'proposed' }).filter(i => i.executable_by_agent === 0 && i.created_at < cutoff)
const byProject: Record<string, number> = {}
for (const r of rows) { transitionActionItem(r.id, 'archived', 'stale-triage'); byProject[r.project_id] = (byProject[r.project_id] ?? 0) + 1 }
console.log('archived', rows.length, byProject)
for (const p of Object.keys(byProject)) reportActionPlanSnapshot(p)
await new Promise(r => setTimeout(r, 4000))
