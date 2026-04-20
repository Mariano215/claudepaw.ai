// One-shot: write Sentinel Security Patrol's new phase_instructions into the
// live paws table. Sourced from scripts/paws-seed.ts so seed and DB stay in
// sync. Safe to re-run; idempotent.
import Database from 'better-sqlite3'
import { join } from 'path'

const phaseInstructions = {
  observe:
    'Read the [Current Security Status] block injected into your prompt above. Pull these fields verbatim:\n' +
    '- score (X/100)\n' +
    '- open findings count + severity breakdown (critical/high/medium/low)\n' +
    '- last scan timestamp + scanner_id + finding count\n' +
    '- the [Open Findings] list (each: severity, scanner, title, target) when present\n\n' +
    'Output a clean summary of what the scanner system found. Do not invent or infer findings. Do not attempt to run scans yourself - the scheduled scanner system runs independently and the dashboard injects the latest results into your prompt above. If the injected context shows zero findings, report that as the truth.',
  analyze:
    "Diff this cycle's open findings (from OBSERVE) against the previous cycle's findings.\n" +
    '- Item present this cycle and not in the prior list: is_new=true\n' +
    '- Item carried from the prior list and still present: is_new=false\n' +
    '- Item present in the prior list but absent this cycle: emit a separate finding with id "resolved-<original-id>", severity=1, is_new=true, title "Resolved: <prior title>"\n\n' +
    'Severity comes from the scanner: critical=5, high=4, medium=3, low=2, info=1.\n\n' +
    'Forbidden: do NOT emit findings about Bash availability, Paw runner state, scan freshness, your own tooling, or the absence of new scan data. Those are noise, not security findings. The scheduled scanner system is the source of truth - if a scanner did not run this cycle, that is fine and not a finding.',
  decide:
    'New high or critical findings (severity >= 4) need approval. Resolutions and unchanged items do not.',
  act:
    'No automated actions. All security findings require human review on the Security dashboard.',
  report:
    'Three sections, each optional. Skip a section entirely when it would be empty.\n\n' +
    'NEW:\n- [sev N] <title> (<target>) - <action>\n\n' +
    'RESOLVED:\n- <title>\n\n' +
    'UNCHANGED:\n- <count> open finding(s) carried with no change since last cycle\n\n' +
    'If score is 100/100 and nothing new or resolved this cycle, say only: "All clear. Score 100/100, no changes since last scan."',
}

const dbPath = join(process.cwd(), 'store', 'claudepaw.db')
const db = new Database(dbPath)

const row = db.prepare('SELECT config FROM paws WHERE id = ?').get('sentinel-patrol') as { config: string } | undefined
if (!row) {
  console.error('sentinel-patrol Paw not found in DB')
  process.exit(1)
}

const config = JSON.parse(row.config) as Record<string, unknown>
config.phase_instructions = phaseInstructions

const updated = db.prepare('UPDATE paws SET config = ? WHERE id = ?').run(JSON.stringify(config), 'sentinel-patrol')
console.log('Sentinel phase_instructions updated. Rows changed:', updated.changes)

const purged = db.prepare('DELETE FROM paw_cycles WHERE paw_id = ?').run('sentinel-patrol')
console.log('Sentinel cycle history purged. Rows deleted:', purged.changes)

db.prepare("UPDATE paws SET status = 'active' WHERE id = ?").run('sentinel-patrol')
console.log('Sentinel status reset to active.')

db.close()
