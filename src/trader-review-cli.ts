// src/trader-review-cli.ts
// The daily and weekly trader review agents run sandboxed: no DB access, no
// file edits. This CLI is their only window and their only lever.
//
//   node dist/trader-review-cli.js report [days]
//       Paper-trading performance, signal funnel, Jev record, knobs and the
//       tuning log, as JSON.
//   node dist/trader-review-cli.js knob-set <key> <value> <reason words...>
//       Change one whitelisted trader knob inside a safe range.
//   node dist/trader-review-cli.js strategy-pause <strategy_id> <reason words...>
//       Pause a strategy. Resuming stays a human decision.
//
// Guardrails: one change per 20 hours (incremental, so each change can be
// judged on its own), whitelist plus ranges, paper only. Nothing here can
// raise size, go live, or touch the kill switch or cost caps.
import { initDatabase, getDb, getProjectSettings, upsertProjectSettings } from './db.js'
import { DASHBOARD_URL, BOT_API_TOKEN } from './config.js'

const DAY_MS = 86_400_000
const MIN_GAP_MS = 20 * 60 * 60 * 1000

/** key -> validator returning the normalized value, or null when out of range. */
const KNOBS: Record<string, (v: string) => string | null> = {
  jev_gate: (v) => (v === 'true' || v === 'false' ? v : null),
  earnings_blackout_days: intIn(0, 10),
  symbol_cooldown_days: intIn(0, 30),
  daily_trade_cap: intIn(1, 20),
}

function intIn(lo: number, hi: number) {
  return (v: string) => (/^\d+$/.test(v) && Number(v) >= lo && Number(v) <= hi ? v : null)
}

function ensureLog(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS trader_tuning_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    reason TEXT NOT NULL
  )`)
}

function knobs(): Record<string, unknown> {
  const raw = getProjectSettings('trader')?.knobs
  return raw ? JSON.parse(raw) as Record<string, unknown> : {}
}

function lastChangeMs(): number {
  const r = getDb().prepare('SELECT MAX(ts) AS ts FROM trader_tuning_log').get() as { ts: number | null }
  return r.ts ?? 0
}

function q<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...params) as T[]
}

function report(days: number): unknown {
  const since = Date.now() - days * DAY_MS
  const pnl = (where: string, ...p: unknown[]) => q(`
    SELECT COUNT(*) AS trades, ROUND(SUM(pnl_net),2) AS net, SUM(pnl_net > 0) AS wins,
      ROUND(AVG(CASE WHEN pnl_net > 0 THEN pnl_net END),2) AS avg_win,
      ROUND(AVG(CASE WHEN pnl_net <= 0 THEN pnl_net END),2) AS avg_loss
    FROM trader_realized_pnl ${where}`, ...p)[0]
  return {
    generated_at: new Date().toISOString(),
    window_days: days,
    realized_all_time: pnl(''),
    realized_window: pnl('WHERE exit_ts_ms >= ?', since),
    realized_by_asset_window: q(`SELECT asset, COUNT(*) AS trades, ROUND(SUM(pnl_net),2) AS net
      FROM trader_realized_pnl WHERE exit_ts_ms >= ? GROUP BY asset ORDER BY net`, since),
    realized_by_strategy_all_time: q(`SELECT s.strategy_id, COUNT(*) AS trades, ROUND(SUM(p.pnl_net),2) AS net
      FROM trader_realized_pnl p JOIN trader_decisions d ON d.id = p.decision_id
      JOIN trader_signals s ON s.id = d.signal_id GROUP BY 1 ORDER BY net`),
    exits_window: q(`SELECT asset, substr(thesis, 1, 120) AS why, datetime(decided_at/1000,'unixepoch') AS at
      FROM trader_decisions WHERE parent_decision_id IS NOT NULL AND decided_at >= ? ORDER BY decided_at`, since),
    open_entries: q(`SELECT d.asset, d.action, ROUND(d.size_usd) AS size_usd, d.entry_price, d.stop_loss, d.take_profit,
      datetime(d.decided_at/1000,'unixepoch') AS at FROM trader_decisions d
      LEFT JOIN trader_verdicts v ON v.decision_id = d.id
      WHERE d.status = 'executed' AND d.action IN ('buy','sell') AND d.parent_decision_id IS NULL
        AND v.decision_id IS NULL`),
    signal_funnel_window: q(`SELECT strategy_id, status, COUNT(*) AS n FROM trader_signals
      WHERE generated_at >= ? GROUP BY 1, 2 ORDER BY 1, 3 DESC`, since),
    decisions_window: q(`SELECT action, status, COUNT(*) AS n FROM trader_decisions
      WHERE decided_at >= ? AND parent_decision_id IS NULL GROUP BY 1, 2`, since),
    jev_window: q(`SELECT json_extract(transcript_json,'$.jev.action') AS jev_action,
      json_extract(transcript_json,'$.jev.error') IS NOT NULL AS jev_error,
      COUNT(*) AS n, ROUND(AVG(json_extract(transcript_json,'$.jev.p_enter')),2) AS avg_p_enter
      FROM trader_committee_transcripts WHERE created_at >= ? AND json_extract(transcript_json,'$.jev') IS NOT NULL
      GROUP BY 1, 2`, since),
    jev_vs_outcome_all_time: q(`SELECT json_extract(t.transcript_json,'$.jev.action') AS jev_action,
      COUNT(p.id) AS closed_lots, ROUND(SUM(p.pnl_net),2) AS net
      FROM trader_committee_transcripts t JOIN trader_decisions d ON d.committee_transcript_id = t.id
      JOIN trader_realized_pnl p ON p.decision_id = d.id
      WHERE json_extract(t.transcript_json,'$.jev') IS NOT NULL GROUP BY 1`),
    strategies: q('SELECT id, status FROM trader_strategies ORDER BY id'),
    knobs: knobs(),
    tuning_log: q(`SELECT datetime(ts/1000,'unixepoch') AS at, kind, target, old_value, new_value, reason
      FROM trader_tuning_log ORDER BY ts DESC LIMIT 30`),
    next_change_allowed_at: new Date(lastChangeMs() + MIN_GAP_MS).toISOString(),
  }
}

async function setKnob(key: string, value: string): Promise<void> {
  // Server first, then the bot copy. Both must agree, or the next dashboard
  // save would push the old server value back to the bot.
  const res = await fetch(`${DASHBOARD_URL}/api/v1/internal/trader-knob`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dashboard-token': BOT_API_TOKEN },
    body: JSON.stringify({ key, value }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`dashboard refused the knob change: HTTP ${res.status}`)
  upsertProjectSettings({ project_id: 'trader', knobs: JSON.stringify({ ...knobs(), [key]: value }) })
}

function guardGap(): void {
  const next = lastChangeMs() + MIN_GAP_MS
  if (Date.now() < next) {
    console.error(`One change per 20 hours. Next change allowed at ${new Date(next).toISOString()}.`)
    process.exit(2)
  }
}

async function main(): Promise<void> {
  initDatabase()
  ensureLog()
  const [cmd, ...args] = process.argv.slice(2)
  const log = getDb().prepare('INSERT INTO trader_tuning_log (ts, kind, target, old_value, new_value, reason) VALUES (?, ?, ?, ?, ?, ?)')

  if (cmd === 'report') {
    const days = Number(args[0] ?? 1)
    console.log(JSON.stringify(report(Number.isFinite(days) && days > 0 ? days : 1), null, 2))
    return
  }
  if (cmd === 'knob-set') {
    const [key, raw, ...why] = args
    const valid = key ? KNOBS[key] : undefined
    if (!valid || raw == null || why.length === 0) {
      console.error(`Usage: knob-set <key> <value> <reason words>. Keys: ${Object.keys(KNOBS).join(', ')}`)
      process.exit(1)
    }
    const value = valid(raw)
    if (value == null) { console.error(`Value ${raw} is out of range for ${key}.`); process.exit(1) }
    guardGap()
    const old = knobs()[key]
    await setKnob(key, value)
    log.run(Date.now(), 'knob', key, old == null ? null : String(old), value, why.join(' '))
    console.log(`Set ${key}: ${old ?? '(default)'} -> ${value}`)
    return
  }
  if (cmd === 'strategy-pause') {
    const [id, ...why] = args
    const row = id ? getDb().prepare('SELECT status FROM trader_strategies WHERE id = ?').get(id) as { status: string } | undefined : undefined
    if (!row || why.length === 0) { console.error('Usage: strategy-pause <strategy_id> <reason words>'); process.exit(1) }
    if (row.status === 'paused') { console.log(`${id} is already paused.`); return }
    guardGap()
    getDb().prepare("UPDATE trader_strategies SET status = 'paused' WHERE id = ?").run(id)
    log.run(Date.now(), 'strategy', id, row.status, 'paused', why.join(' '))
    console.log(`Paused ${id}.`)
    return
  }
  console.error('Commands: report [days] | knob-set <key> <value> <reason> | strategy-pause <id> <reason>')
  process.exit(1)
}

main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1) })
