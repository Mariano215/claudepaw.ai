// src/paws/broker-paw-defs.ts
//
// Paw definitions for the Paw Broker project (BRRRR + STR real estate).
//
// 17 paws total: 1 migrated (re-property-scout) + 16 net-new.
//
// Approval threshold convention:
//   threshold = 6 -> auto-execute (no severity reaches 6)
//   threshold = 1 -> always gate at DECIDE (any finding requires Telegram approval)
//
// DECIDE-gated paws per plan §4: cost-seg engagement, refi execution,
// property-tax-appeal filing. All other broker paws auto-execute --
// findings are intel-only, no money/legal commitment without human approval.
//
// Collector pattern: paws with `observe_collector` set get raw data from
// a deterministic TS function in src/paws/collectors/broker-*.ts. The
// observe phase is omitted; analyze sees the collector JSON. Paws without
// a collector run a Bash-driven observe phase (sqlite3 / gh / curl).

import { ALLOWED_CHAT_ID } from '../config.js'

const chatId = ALLOWED_CHAT_ID || process.env.TELEGRAM_CHAT_ID || ''

// Local PawSeed shape mirrors scripts/paws-seed.ts. Kept inline so this
// module can be imported without a circular dep on the seed script.
export interface PawSeed {
  id: string
  project_id: string
  name: string
  agent_id: string
  cron: string
  status: 'active' | 'paused'
  approval_threshold: number
  approval_timeout_sec: number
  phase_instructions?: Record<string, string>
  observe_collector?: string
  observe_collector_args?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Shared prompt fragments (DRY)
// ---------------------------------------------------------------------------

const ZIP_TIERS = [
  'Quarter 0 (week-of-month % 4 == 0) -- STR overlay scan only:',
  '  Philly STR-zoned: 19103, 19106, 19107, 19123, 19125',
  '  Beach: 08204, 08260, 08202, 08243, 08226, 19971, 19958',
  '  Pocono/lake: 18301, 18360',
  'Quarter 1 -- Tier 1 BRRRR hunt + STR overlay:',
  '  Philly: 19142, 19143, 19139, 19140, 19132, 19134, 19124, 19120, 19138, 19141',
  '  Delco: 19013, 19033, 19023, 19036, 19050, 19082',
  '  Camden NJ: 08104, 08105',
  '  Wilmington DE: 19801, 19802, 19805',
  'Quarter 2 -- Tier 2 workforce LTR + STR overlay:',
  '  Delco: 19026, 19064, 19081, 19094, 19078, 19070',
  '  Bucks/Mont: 19006, 19044, 19075, 19046, 19090, 19020',
  '  NE Philly: 19111, 19136, 19149, 19152',
  'Quarter 3 -- Tier 3 hold + STR overlay:',
  '  Mont Co: 19010, 19087, 19035, 19460',
  '  Bucks: 18901, 18940, 19067',
  '  S Jersey: 08003, 08033',
].join('\n')

const CONSERVATIVE_DEAL_BOX = [
  'Conservative deal box (analyzer default):',
  '  BRRRR: all-in basis <= 70% ARV; rent >= 1.1% ARV/mo; DSCR @ refi >= 1.30 at quoted rate +1.5% stress; 6-mo seasoning; $5k contingency floor.',
  '  Flip: max offer = 0.65 * ARV - rehab - $25k - 4.278% Philly transfer tax; 9-mo holding stress.',
  '  STR: ADR * 0.65 occupancy; gross multiplier <= 8x; MUST clear DSCR >= 1.30 at LTR backstop rent.',
  '  Buy-and-hold no-rehab: 1% rule strict + DSCR >= 1.35 + CoC >= 9%.',
].join('\n')

const REPORT_DISCIPLINE = [
  'REPORT discipline: plain text only. No markdown. No emoji. No HTML.',
  'Telegram chats render plain text. The formatter strips markup -- skip the cleanup tax.',
  'Tight: 2-4 lines max for normal cycles. Lead with the action item.',
].join('\n')

const CPA_DISCLAIMER = 'Footer (mandatory on all tax-strategy outputs): "Not tax advice. Verify with your CPA before action."'

// ---------------------------------------------------------------------------
// Paw definitions
// ---------------------------------------------------------------------------

export const brokerPaws: PawSeed[] = [

  // ── re-property-scout (migrated from default to broker) ────────────────
  // Mondays 8am ET. STR overlay always; Tier 1/2/3 zip rotation by week-of-month.
  {
    id: 're-property-scout',
    project_id: 'broker',
    name: 'Property Scout',
    agent_id: 'broker--scout',
    cron: '0 8 * * 1',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    observe_collector: 'broker-listings',
    observe_collector_args: { max_price: 350000 },
    phase_instructions: {
      analyze: [
        'ANALYZE: The collector returned listings for this week\'s zip rotation + STR overlay.',
        '',
        'Zip rotation reference (week-of-month % 4 selects the active quarter, STR overlay always on):',
        ZIP_TIERS,
        '',
        CONSERVATIVE_DEAL_BOX,
        '',
        'Apply hard filters first (auto-reject):',
        '  price <= $350k AND beds >= 3 AND sqft >= 900',
        '  NOT in FEMA flood zone AE/VE',
        '  NOT (foundation/structural/knob-and-tube/asbestos-friable/sinkhole/fire-damage AND price > 60% zip median)',
        '  year_built >= 1900',
        '  tax_delinquent_amount < $25k',
        '',
        'Severity guide (favors deals that pass conservative tests by margin):',
        '  5 = STR-zone or beach market AND fixer/distressed AND price <= 70% zip median',
        '  5 = Tier 1 BRRRR fixer under $200k with <=60 DOM',
        '  4 = STR-zone or beach market priced at fair market with cash-flow upside',
        '  4 = Tier 1 BRRRR with strong fixer signals (as-is, estate, vacant, motivated)',
        '  4 = Duplex/triplex/quad under $250k in any tier',
        '  3 = Tier 2/3 with DOM >= 60 (motivated seller signal)',
        '  3 = Mid-tier with marginal margin -- worth tracking',
        '  2 = Marginal awareness',
        '  1 = Skip',
        '',
        'is_new=true if address not in previousFindings. is_new=true if seen before but price dropped >= $5k -- prefix title with "PRICE DROP:".',
        'Only return findings with severity >= 2 and is_new=true.',
        '',
        'JSON only:',
        '{"findings":[{"id":"addr-zip","severity":1-5,"title":"address + price + tier","detail":"beds/baths/sqft, DOM, deal_type (BRRRR|STR|flip), why flagged","is_new":true}]}',
      ].join('\n'),
      decide: [
        'DECIDE: severity >= 2 -> action="act"; severity < 2 -> action="skip".',
        'Auto-decide. Scout is intel-only -- no capital commitment from a flag.',
        'JSON only:',
        '{"decisions":[{"finding_id":"string","action":"act|skip","reason":"string"}],"max_severity":number}',
      ].join('\n'),
      act: [
        'ACT: Insert flagged findings into the deals table as new rows (status=sourced).',
        '',
        'For each acting finding, run via Bash:',
        '  /opt/homebrew/bin/sqlite3 ./store/claudepaw.db "',
        '    INSERT OR IGNORE INTO deals',
        '      (id, project_id, source_paw_id, address, zip, list_price, est_arv, est_rehab,',
        '       est_rent_monthly, deal_type, status, severity, notes, created_at, updated_at)',
        '    VALUES (\'<slug-of-address>\', \'broker\', \'re-property-scout\', \'<addr>\', \'<zip>\',',
        '            <price>, <est_arv>, <est_rehab>, <est_rent>, \'<str|ltr-brrrr|flip|hold>\',',
        '            \'sourced\', <severity>, \'<notes>\', strftime(\'%s\',\'now\')*1000, strftime(\'%s\',\'now\')*1000);"',
        '',
        'Then send Telegram digest:',
        '  ./scripts/notify.sh "Broker Scout: N new flags this week. Top: <addr> (<tier>, <deal_type>, sev <N>). Reply analyze <addr> for full underwrite."',
      ].join('\n'),
      report: [
        REPORT_DISCIPLINE,
        '',
        'Include: total new flags, top 1-2 (address, deal_type, severity), reminder "reply analyze <addr> for BRRRR/STR math".',
        'If empty: "Broker Scout: no new flags across [tier] + STR overlay this week."',
      ].join('\n'),
    },
  },

  // ── re-str-pricing-watch ───────────────────────────────────────────────
  // Daily 7am ET. Sweep ADR/occupancy on owned STRs vs comps; flag underpricing >10%.
  {
    id: 're-str-pricing-watch',
    project_id: 'broker',
    name: 'STR Pricing Watch',
    agent_id: 'broker--str-ops',
    cron: '0 7 * * *',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    observe_collector: 'broker-str-pricing',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned per-STR-property pricing snapshot:',
        '  current_adr, current_occupancy_30d, comp_median_adr, comp_median_occupancy_30d.',
        '',
        'Severity guide:',
        '  4 = current_adr < 0.90 * comp_median_adr (underpriced >10%)',
        '  4 = current_occupancy_30d < comp_median_occupancy * 0.85 (vacancy gap)',
        '  3 = next 14 days occupancy < 50% with no pricing action',
        '  2 = healthy pricing within 5% of comps',
        '',
        'Skip findings with no listed STRs (zero current str_listing_url in properties).',
        'JSON only:',
        '{"findings":[{"id":"property-id","severity":1-5,"title":"property + delta","detail":"current vs comp ADR/occ + recommended adjustment","is_new":true}]}',
      ].join('\n'),
      decide: [
        'DECIDE: All severities auto-act (intel only -- pricing changes happen in PriceLabs/Wheelhouse manually).',
        'JSON only: {"decisions":[{"finding_id":"id","action":"act","reason":"surface signal"}],"max_severity":number}',
      ].join('\n'),
      act: [
        'ACT: Send Telegram with one line per flagged property + recommended ADR.',
        '  ./scripts/notify.sh "STR Pricing: <property> ADR <current> vs comps <median>. Suggest <new_adr>."',
        'No DB write -- this paw is intel only.',
      ].join('\n'),
      report: [REPORT_DISCIPLINE, 'If empty: "STR Pricing: all owned STRs within 5% of market comps."'].join('\n'),
    },
  },

  // ── re-material-participation-tracker ──────────────────────────────────
  // Daily 7pm ET. Compute STR/REPS hour totals; nudge user to log today.
  {
    id: 're-material-participation-tracker',
    project_id: 'broker',
    name: 'Material Participation Tracker',
    agent_id: 'broker--tax-strategist',
    cron: '0 19 * * *',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    observe_collector: 'broker-participation-snapshot',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned hour totals YTD:',
        '  per_property_str_hours[], reps_hours_total, days_remaining_in_year, last_log_date.',
        '',
        'STR threshold: 100 hrs/property AND more than anyone else on that property.',
        'REPS threshold: 750 hrs/year AND >50% personal services in real property.',
        '',
        'Severity guide:',
        '  5 = any STR property < 50 hrs with <90 days left in year (loophole at risk)',
        '  4 = REPS pace below trajectory (current * 365/elapsed_days < 750)',
        '  4 = no log entry in last 7 days',
        '  3 = healthy pace; routine end-of-day nudge',
        '  2 = ahead of pace, casual reminder',
        '',
        CPA_DISCLAIMER,
        '',
        'JSON only:',
        '{"findings":[{"id":"snapshot-yyyymmdd","severity":1-5,"title":"hours summary","detail":"per-property + REPS pace","is_new":true}]}',
      ].join('\n'),
      decide: [
        'DECIDE: Auto-act. Tracker is a nudge, not a money move.',
        'JSON only: {"decisions":[{"finding_id":"id","action":"act","reason":"daily nudge"}],"max_severity":number}',
      ].join('\n'),
      act: [
        'ACT: Send Telegram nudge with current totals + reply hint to log:',
        '  ./scripts/notify.sh "Participation: STR <prop> Xhr / 100. REPS Yhr / 750. Reply: log <hrs> <activity> [property] to add today\'s entry."',
      ].join('\n'),
      report: [REPORT_DISCIPLINE].join('\n'),
    },
  },

  // ── re-cost-seg-candidate-scan (DECIDE-gate) ───────────────────────────
  // Monthly 1st 9am. List eligible properties; engaging a study = capital, gates.
  {
    id: 're-cost-seg-candidate-scan',
    project_id: 'broker',
    name: 'Cost Seg Candidate Scan',
    agent_id: 'broker--tax-strategist',
    cron: '0 9 1 * *',
    status: 'active',
    approval_threshold: 1,
    approval_timeout_sec: 86_400,
    observe_collector: 'broker-cost-seg-candidates',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned candidate properties:',
        '  basis >= $300k, owned, no cost_seg_studies row with status=engaged|complete.',
        'Each candidate has: property_id, address, basis, acquisition_date, year, OBBB-eligible flag (acq >= 2025-01-19), ARV.',
        '',
        'OBBB Act permanently restored 100% bonus depreciation for property acquired after Jan 19 2025.',
        'Look-back study allowed for any owned property even if acquired earlier (Form 3115).',
        '',
        'Severity guide:',
        '  5 = OBBB-eligible AND basis >= $400k (highest Year-1 deduction)',
        '  4 = OBBB-eligible AND basis $300-400k',
        '  3 = look-back candidate (acq pre-2025) AND basis >= $300k',
        '  2 = marginal',
        '',
        CPA_DISCLAIMER,
        '',
        'JSON only:',
        '{"findings":[{"id":"property-id","severity":1-5,"title":"address + projected Y1 deduction","detail":"basis/ARV/firm rec/study cost vs deduction","is_new":true}]}',
      ].join('\n'),
      decide: [
        'DECIDE: Cost-seg engagement = $3-5k commitment. Always gate.',
        'JSON only: {"decisions":[{"finding_id":"id","action":"escalate","reason":"engagement requires approval"}],"max_severity":number}',
      ].join('\n'),
      act: [
        'ACT (post-approval): Insert into cost_seg_studies with status=planned.',
        '  /opt/homebrew/bin/sqlite3 ./store/claudepaw.db "',
        '    INSERT INTO cost_seg_studies (id, project_id, property_id, status, total_basis, year1_deduction, notes, created_at)',
        '    VALUES (\'<slug>\', \'broker\', \'<property_id>\', \'planned\', <basis>, <projected>, \'Approved <date>\', strftime(\'%s\',\'now\')*1000);"',
        'Then notify:',
        '  ./scripts/notify.sh "Cost-seg engagement queued: <addr>. Outreach to firm next."',
      ].join('\n'),
      report: [REPORT_DISCIPLINE, CPA_DISCLAIMER].join('\n'),
    },
  },

  // ── re-philly-ltta-renewal ─────────────────────────────────────────────
  // Quarterly: Jan/Apr/Jul/Oct 1st 8am. Pull OPA records for owned Philly props.
  {
    id: 're-philly-ltta-renewal',
    project_id: 'broker',
    name: 'Philly LTTA Renewal Watch',
    agent_id: 'broker--tax-strategist',
    cron: '0 8 1 1,4,7,10 *',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    observe_collector: 'broker-ltta-status',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned per-Philly-property OPA records + tax_abatements row state:',
        '  property_id, address, abatement_program, frozen_assessment, current_assessment, end_date, recert_due, days_until_recert.',
        '',
        'Severity guide:',
        '  5 = recert_due in next 30 days',
        '  4 = recert_due in 31-90 days',
        '  3 = current assessment >> frozen (savings tracking on)',
        '  2 = abatement healthy, no action',
        '',
        'JSON only:',
        '{"findings":[{"id":"property-id","severity":1-5,"title":"addr + recert deadline","detail":"savings vs deadline","is_new":true}]}',
      ].join('\n'),
      decide: ['DECIDE: Auto-act. Calendar reminders only -- the operator files recert manually.', 'JSON only: {"decisions":[{"finding_id":"id","action":"act","reason":"reminder"}],"max_severity":number}'].join('\n'),
      act: [
        'ACT: Send Telegram + insert tax_event row of type ltta_recert when recert_due in next 60 days:',
        '  /opt/homebrew/bin/sqlite3 ./store/claudepaw.db "',
        '    INSERT OR IGNORE INTO tax_events (id, project_id, event_type, property_id, due_date, status, notes, created_at)',
        '    VALUES (\'ltta-<property_id>-<due_date>\', \'broker\', \'ltta_recert\', \'<property_id>\', \'<due_date>\', \'open\', \'Auto-flagged by re-philly-ltta-renewal\', strftime(\'%s\',\'now\')*1000);"',
        '  ./scripts/notify.sh "LTTA: <addr> recert due <date>. Annual savings $<amount>."',
      ].join('\n'),
      report: [REPORT_DISCIPLINE].join('\n'),
    },
  },

  // ── re-deal-pipeline-stale ─────────────────────────────────────────────
  // Tue/Fri 9am. Nudge deals untouched >7d.
  {
    id: 're-deal-pipeline-stale',
    project_id: 'broker',
    name: 'Deal Pipeline Stale Watch',
    agent_id: 'broker--orchestrator',
    cron: '0 9 * * 2,5',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    observe_collector: 'broker-pipeline-snapshot',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned deals snapshot:',
        '  deals[] with id, address, status, severity, days_since_update, days_in_status.',
        '',
        'Severity guide:',
        '  4 = under-contract for >14 days with no movement (closing risk)',
        '  3 = under-review for >10 days (deal getting stale)',
        '  2 = sourced for >7 days (entry triage backlog)',
        '  1 = healthy',
        '',
        'JSON only:',
        '{"findings":[{"id":"deal-id","severity":1-5,"title":"addr + status + days","detail":"why stale + suggested action","is_new":true}]}',
      ].join('\n'),
      decide: ['DECIDE: Auto-act. Reminder only.', 'JSON only: {"decisions":[{"finding_id":"id","action":"act","reason":"nudge"}],"max_severity":number}'].join('\n'),
      act: ['ACT: Telegram nudge with the stale list + suggested next move per deal.', '  ./scripts/notify.sh "Pipeline: N stale deals. Top: <addr> in <status> for <days>d. <suggestion>."'].join('\n'),
      report: [REPORT_DISCIPLINE].join('\n'),
    },
  },

  // ── re-refi-monitor (DECIDE-gate) ──────────────────────────────────────
  // Monthly 1st 9am. Flag properties at >=75% LTV refi window.
  {
    id: 're-refi-monitor',
    project_id: 'broker',
    name: 'Refi Window Monitor',
    agent_id: 'broker--finance-officer',
    cron: '0 9 1 * *',
    status: 'active',
    approval_threshold: 1,
    approval_timeout_sec: 86_400,
    observe_collector: 'broker-equity-snapshot',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned equity per property:',
        '  property_id, address, current_arv, last_loan_balance, ltv, brrrr_phase, seasoning_months, last_refi_date.',
        '',
        'BRRRR refi window: seasoning >= 6 months AND ltv >= 75% (room to pull cash via DSCR refi).',
        '',
        'Severity guide:',
        '  5 = seasoning >= 6mo AND ltv >= 80% (immediate refi candidate, big cash-out)',
        '  5 = brrrr_phase = "refi" (next BRRRR step due)',
        '  4 = seasoning >= 6mo AND ltv 75-80%',
        '  3 = ltv climbing toward 75% (track for next quarter)',
        '  2 = healthy LTV, no action',
        '',
        'JSON only:',
        '{"findings":[{"id":"property-id","severity":1-5,"title":"addr + projected cash-out","detail":"current vs target ltv + lender shop","is_new":true}]}',
      ].join('\n'),
      decide: [
        'DECIDE: Refi execution = capital event + new debt + closing costs. Always gate.',
        'JSON only: {"decisions":[{"finding_id":"id","action":"escalate","reason":"refi requires approval"}],"max_severity":number}',
      ].join('\n'),
      act: [
        'ACT (post-approval): Insert financing_events row of type refi (status notes Approved):',
        '  /opt/homebrew/bin/sqlite3 ./store/claudepaw.db "',
        '    INSERT INTO financing_events (id, project_id, property_id, event_type, ltv, lender, notes, created_at)',
        '    VALUES (\'refi-<property_id>-<yyyymmdd>\', \'broker\', \'<property_id>\', \'refi\', <ltv>,',
        '            \'<lender or planning>\', \'Approved <date>: pursue DSCR refi quotes\', strftime(\'%s\',\'now\')*1000);"',
        '  ./scripts/notify.sh "Refi authorized: <addr>. Lender outreach next (Lima One / Kiavi / RCN / local CU)."',
      ].join('\n'),
      report: [REPORT_DISCIPLINE].join('\n'),
    },
  },

  // ── re-portfolio-health ────────────────────────────────────────────────
  // Mondays 8am. DSCR / vacancy / CoC roll-up.
  {
    id: 're-portfolio-health',
    project_id: 'broker',
    name: 'Portfolio Health Roll-Up',
    agent_id: 'broker--portfolio-cfo',
    cron: '0 8 * * 1',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    observe_collector: 'broker-portfolio-rollup',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned per-property roll-up + portfolio totals:',
        '  per_property[] = {id, addr, monthly_rent_or_str_revenue, monthly_debt_service, dscr, vacancy_pct_30d, coc_ttm}',
        '  portfolio = {total_doors, weighted_avg_dscr, blended_coc, total_equity, monthly_cash_flow}',
        '',
        'Severity guide:',
        '  5 = any door dscr < 1.0 (negative cash flow)',
        '  4 = portfolio weighted dscr < 1.20 (stressed)',
        '  4 = any door vacancy_pct_30d > 30',
        '  3 = blended coc < 7%',
        '  2 = healthy',
        '',
        'JSON only:',
        '{"findings":[{"id":"portfolio-yyyymmdd","severity":1-5,"title":"portfolio summary","detail":"top 3 metrics + worst-door callout","is_new":true}]}',
      ].join('\n'),
      decide: ['DECIDE: Auto-act. Reporting only.', 'JSON only: {"decisions":[{"finding_id":"id","action":"act","reason":"weekly health check"}],"max_severity":number}'].join('\n'),
      act: [
        'ACT: Telegram weekly health digest:',
        '  ./scripts/notify.sh "Portfolio: N doors, DSCR <avg>, CoC <pct>%, monthly CF $<amt>. Worst: <addr> (<reason>)."',
      ].join('\n'),
      report: [REPORT_DISCIPLINE].join('\n'),
    },
  },

  // ── re-market-shift-watcher ────────────────────────────────────────────
  // Wednesdays 10am. Flag >5% MoM rent/price shifts per zip in our universe.
  {
    id: 're-market-shift-watcher',
    project_id: 'broker',
    name: 'Market Shift Watcher',
    agent_id: 'broker--scout',
    cron: '0 10 * * 3',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    observe_collector: 'broker-market-deltas',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned per-zip market delta:',
        '  zip, median_price_now, median_price_1mo_ago, pct_change, median_rent_now, median_rent_1mo_ago, rent_pct_change, sample_size.',
        '',
        'Severity guide:',
        '  4 = any zip in active tier with abs(pct_change) > 7% AND sample_size >= 10',
        '  3 = abs(pct_change) > 5% in any tier',
        '  2 = noteworthy shift in non-target zip',
        '',
        'Skip zips outside our tiered universe.',
        '',
        'JSON only:',
        '{"findings":[{"id":"zip-yyyymm","severity":1-5,"title":"zip + delta","detail":"price/rent shift + tier + interpretation","is_new":true}]}',
      ].join('\n'),
      decide: ['DECIDE: Auto-act. Intel only.', 'JSON only: {"decisions":[{"finding_id":"id","action":"act","reason":"intel"}],"max_severity":number}'].join('\n'),
      act: ['ACT: Telegram digest of >5% MoM zip shifts.', '  ./scripts/notify.sh "Market shift: <zip> <metric> <delta>%. Reread the buy box for that zip."'].join('\n'),
      report: [REPORT_DISCIPLINE].join('\n'),
    },
  },

  // ── re-tax-deadline-tracker ────────────────────────────────────────────
  // Daily 7am. 1031 clocks, Q-est, REPS hour pace.
  {
    id: 're-tax-deadline-tracker',
    project_id: 'broker',
    name: 'Tax Deadline Tracker',
    agent_id: 'broker--tax-strategist',
    cron: '0 7 * * *',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    observe_collector: 'broker-tax-clock',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned tax_events table snapshot:',
        '  open_events[] = {id, event_type, property_id, due_date, days_until_due, amount, hours}.',
        '',
        '1031 clocks: 45-day identification, 180-day close. Hard IRS deadlines.',
        'Q-estimate: Apr 15 / Jun 15 / Sep 15 / Jan 15. IRS penalties for underpayment.',
        'REPS milestones: 750 hrs/yr -- pace check.',
        '',
        'Severity guide:',
        '  5 = 1031 deadline in next 7 days',
        '  5 = Q-est due in next 7 days AND no amount logged',
        '  4 = 1031 deadline in next 30 days',
        '  4 = REPS pace falls below 750/yr trajectory',
        '  3 = LTTA recert in next 60 days',
        '  2 = misc upcoming events',
        '',
        CPA_DISCLAIMER,
        '',
        'JSON only:',
        '{"findings":[{"id":"event-id","severity":1-5,"title":"event_type + due_date","detail":"days remaining + action","is_new":true}]}',
      ].join('\n'),
      decide: ['DECIDE: Auto-act. Reminder only.', 'JSON only: {"decisions":[{"finding_id":"id","action":"act","reason":"reminder"}],"max_severity":number}'].join('\n'),
      act: ['ACT: Telegram daily tax-clock summary.', '  ./scripts/notify.sh "Tax clock: <event> due <date> (<days>d). <next_step>. Verify with CPA."'].join('\n'),
      report: [REPORT_DISCIPLINE, CPA_DISCLAIMER].join('\n'),
    },
  },

  // ── re-insurance-renewal ───────────────────────────────────────────────
  // Monthly 1st 7am. 60/30/7-day renewal alerts on policies.
  {
    id: 're-insurance-renewal',
    project_id: 'broker',
    name: 'Insurance Renewal Watch',
    agent_id: 'broker--legal-shield',
    cron: '0 7 1 * *',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    observe_collector: 'broker-policy-roll',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned insurance roll-up from expenses + tax_events tables:',
        '  per_property_policy[] = {property_id, addr, policy_type, renewal_date, days_until_renewal, premium, carrier_known}.',
        'Policy types: GL, builders_risk, umbrella, str_specific, flood, wind.',
        '',
        'Severity guide:',
        '  5 = renewal in next 7 days',
        '  4 = renewal in 8-30 days',
        '  3 = renewal in 31-60 days',
        '  3 = property without any policy logged (gap)',
        '  2 = healthy',
        '',
        'JSON only:',
        '{"findings":[{"id":"policy-id-or-gap","severity":1-5,"title":"property + policy + due","detail":"premium + carrier + action","is_new":true}]}',
      ].join('\n'),
      decide: ['DECIDE: Auto-act. Reminder only.', 'JSON only: {"decisions":[{"finding_id":"id","action":"act","reason":"reminder"}],"max_severity":number}'].join('\n'),
      act: ['ACT: Telegram renewal digest.', '  ./scripts/notify.sh "Insurance: <property> <policy> renews <date> ($<premium>). Confirm shop done."'].join('\n'),
      report: [REPORT_DISCIPLINE].join('\n'),
    },
  },

  // ── re-property-tax-appeal (DECIDE-gate) ───────────────────────────────
  // Jan + Jul 1st 8am. County overassessment scan -- filing = approval gate.
  {
    id: 're-property-tax-appeal',
    project_id: 'broker',
    name: 'Property Tax Appeal Watch',
    agent_id: 'broker--tax-strategist',
    cron: '0 8 1 1,7 *',
    status: 'active',
    approval_threshold: 1,
    approval_timeout_sec: 86_400,
    observe_collector: 'broker-assessment-pull',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned per-Philly+Delco-property assessment data:',
        '  property_id, addr, county, current_assessment, comparable_sales_median, est_market_value, overassessed_pct.',
        '',
        'Appeal candidate: assessed at >= 110% of est market value.',
        '',
        'Severity guide:',
        '  4 = overassessed >= 25% (strong appeal case)',
        '  3 = overassessed 15-25%',
        '  2 = overassessed 10-15% (marginal)',
        '  1 = at or below market',
        '',
        'JSON only:',
        '{"findings":[{"id":"property-id","severity":1-5,"title":"addr + overassessment %","detail":"current vs market + filing window","is_new":true}]}',
      ].join('\n'),
      decide: [
        'DECIDE: Filing an appeal = legal action with risk of triggering reassessment. Always gate.',
        'JSON only: {"decisions":[{"finding_id":"id","action":"escalate","reason":"appeal filing requires approval"}],"max_severity":number}',
      ].join('\n'),
      act: [
        'ACT (post-approval): Insert tax_event for appeal_filing tracking.',
        '  /opt/homebrew/bin/sqlite3 ./store/claudepaw.db "',
        '    INSERT INTO tax_events (id, project_id, event_type, property_id, due_date, amount, status, notes, created_at)',
        '    VALUES (\'appeal-<property_id>-<yyyymmdd>\', \'broker\', \'property_tax_due\', \'<property_id>\', \'<filing_deadline>\',',
        '            <est_savings>, \'open\', \'Appeal approved <date>: prep evidence + comp pull\', strftime(\'%s\',\'now\')*1000);"',
        '  ./scripts/notify.sh "Appeal authorized: <addr>. Filing deadline <date>. Evidence prep next."',
      ].join('\n'),
      report: [REPORT_DISCIPLINE].join('\n'),
    },
  },

  // ── re-tenant-screening-queue (no collector -- DB query in observe) ────
  // Daily 9am. Flag LTR applications pending >48h.
  {
    id: 're-tenant-screening-queue',
    project_id: 'broker',
    name: 'Tenant Screening Queue',
    agent_id: 'broker--pm-ops',
    cron: '0 9 * * *',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    phase_instructions: {
      observe: [
        'OBSERVE: Query bot DB for LTR applications pending more than 48 hours.',
        'Run via Bash:',
        '  /opt/homebrew/bin/sqlite3 -json ./store/claudepaw.db "',
        '    SELECT t.id, t.name, t.email, t.phone, t.screening_score, t.notes, t.created_at',
        '    FROM tenants t',
        '    WHERE t.project_id = \'broker\'',
        '      AND t.screening_score IS NULL',
        '      AND t.created_at < (strftime(\'%s\',\'now\') - 172800) * 1000',
        '    ORDER BY t.created_at ASC LIMIT 50;"',
        '',
        'Output the rows (or empty array). Do NOT invent applicants.',
      ].join('\n'),
      analyze: [
        'ANALYZE: Each unscreened tenant > 48h old is one finding.',
        '',
        'Severity guide:',
        '  4 = pending > 96 hours (way past responsive window)',
        '  3 = pending 48-96 hours',
        '',
        'JSON only:',
        '{"findings":[{"id":"tenant-id","severity":1-5,"title":"name + days waiting","detail":"contact + suggested next step","is_new":true}]}',
      ].join('\n'),
      decide: ['DECIDE: Auto-act. Reminder only.', 'JSON only: {"decisions":[{"finding_id":"id","action":"act","reason":"nudge"}],"max_severity":number}'].join('\n'),
      act: ['ACT: Telegram nudge to run screening.', '  ./scripts/notify.sh "Tenant screening: <name> waiting <days>d. Pull credit + bg check + verify income today."'].join('\n'),
      report: [REPORT_DISCIPLINE].join('\n'),
    },
  },

  // ── re-str-cleaning-turnover ───────────────────────────────────────────
  // Daily 10am. Confirm cleaner scheduled for every checkout in next 48h.
  {
    id: 're-str-cleaning-turnover',
    project_id: 'broker',
    name: 'STR Cleaning Turnover',
    agent_id: 'broker--str-ops',
    cron: '0 10 * * *',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    observe_collector: 'broker-str-bookings-snapshot',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned str_bookings + scheduled cleaning expenses:',
        '  upcoming_checkouts[] = {booking_id, property_id, addr, check_out, has_cleaning_scheduled (bool)}.',
        '',
        'Severity guide:',
        '  5 = checkout in next 24h with NO cleaning scheduled',
        '  4 = checkout in 24-48h with no cleaning',
        '  2 = healthy (cleaning logged)',
        '',
        'JSON only:',
        '{"findings":[{"id":"booking-id","severity":1-5,"title":"addr + checkout","detail":"cleaner status + action","is_new":true}]}',
      ].join('\n'),
      decide: ['DECIDE: Auto-act. Operational nudge.', 'JSON only: {"decisions":[{"finding_id":"id","action":"act","reason":"nudge"}],"max_severity":number}'].join('\n'),
      act: ['ACT: Telegram nudge.', '  ./scripts/notify.sh "STR cleaning gap: <addr> checkout <date>. Confirm cleaner now."'].join('\n'),
      report: [REPORT_DISCIPLINE].join('\n'),
    },
  },

  // ── re-contractor-vendor-tracker ───────────────────────────────────────
  // Fridays 10am. Vendor scoreboard.
  {
    id: 're-contractor-vendor-tracker',
    project_id: 'broker',
    name: 'Contractor Vendor Tracker',
    agent_id: 'broker--rehab-estimator',
    cron: '0 10 * * 5',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    observe_collector: 'broker-vendor-rollup',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned per-contractor scoreboard:',
        '  contractors[] = {id, name, trade, on_time_pct, budget_variance_pct, callback_rate, last_used_at, jobs_count}.',
        '',
        'Severity guide:',
        '  4 = active contractor with on_time_pct < 70 OR callback_rate > 20',
        '  3 = budget_variance_pct > 15 (cost creep)',
        '  2 = healthy / no recent jobs',
        '',
        'JSON only:',
        '{"findings":[{"id":"contractor-id","severity":1-5,"title":"name + trade + flag","detail":"score breakdown + recommendation","is_new":true}]}',
      ].join('\n'),
      decide: ['DECIDE: Auto-act. Intel only.', 'JSON only: {"decisions":[{"finding_id":"id","action":"act","reason":"intel"}],"max_severity":number}'].join('\n'),
      act: ['ACT: Telegram weekly digest.', '  ./scripts/notify.sh "Vendor watch: <name> (<trade>) flagged: <reason>. Consider sub-out."'].join('\n'),
      report: [REPORT_DISCIPLINE].join('\n'),
    },
  },

  // ── re-father-broker-pocket-feed ───────────────────────────────────────
  // Twice daily 8am + 2pm Mon-Fri. Pull/parse Gmail label pocket/broker.
  {
    id: 're-father-broker-pocket-feed',
    project_id: 'broker',
    name: 'Father Broker Pocket Feed',
    agent_id: 'broker--scout',
    cron: '0 8,14 * * 1-5',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    observe_collector: 'broker-father-broker-inbox',
    phase_instructions: {
      analyze: [
        'ANALYZE: Collector returned new pocket-listing emails parsed from the pocket/broker Gmail label:',
        '  listings[] = {message_id, from, received_at_ms, address, zip, list_price (if parsed), notes_excerpt}.',
        '',
        'Severity guide (mirrors scout sev table when address+price parseable):',
        '  5 = STR-zone or beach market AND price <= 70% zip median',
        '  4 = Tier 1 BRRRR with strong fixer signals',
        '  3 = Tier 2/3 reasonable',
        '  2 = info only / unparsed -- log for manual review',
        '',
        'JSON only:',
        '{"findings":[{"id":"message-id","severity":1-5,"title":"addr + price","detail":"why interesting + tier match","is_new":true}]}',
      ].join('\n'),
      decide: ['DECIDE: Auto-act. Father feed is intel + auto-insert into father_broker_listings.', 'JSON only: {"decisions":[{"finding_id":"id","action":"act","reason":"intake"}],"max_severity":number}'].join('\n'),
      act: [
        'ACT: Insert each new finding into father_broker_listings table.',
        '  /opt/homebrew/bin/sqlite3 ./store/claudepaw.db "',
        '    INSERT OR IGNORE INTO father_broker_listings',
        '      (id, project_id, address, zip, list_price, off_market, source, notes, received_at, status, created_at)',
        '    VALUES (\'<message_id>\', \'broker\', \'<address>\', \'<zip>\', <price>, 1, \'pocket\',',
        '            \'<excerpt>\', <received_at_ms>, \'new\', strftime(\'%s\',\'now\')*1000);"',
        '  ./scripts/notify.sh "Father feed: N new pocket listings. Top: <addr> (<tier>, sev <N>). Reply analyze <addr>."',
      ].join('\n'),
      report: [REPORT_DISCIPLINE].join('\n'),
    },
  },

  // ── re-investments-log-nudge (no collector -- DB query in observe) ─────
  // Monthly 1st 9am. Nudge user to update non-RE investment values.
  {
    id: 're-investments-log-nudge',
    project_id: 'broker',
    name: 'Investments Log Nudge',
    agent_id: 'broker--portfolio-cfo',
    cron: '0 9 1 * *',
    status: 'active',
    approval_threshold: 6,
    approval_timeout_sec: 3600,
    phase_instructions: {
      observe: [
        'OBSERVE: Query bot DB for stalest as_of dates per non-RE investment account.',
        'Run via Bash:',
        '  /opt/homebrew/bin/sqlite3 -json ./store/claudepaw.db "',
        '    SELECT account_label, asset_type, MAX(as_of) AS last_as_of, COUNT(*) AS rows',
        '    FROM investments WHERE project_id = \'broker\'',
        '    GROUP BY account_label, asset_type',
        '    ORDER BY last_as_of ASC LIMIT 25;"',
        '',
        'Empty result is fine -- treat as "no accounts logged yet".',
      ].join('\n'),
      analyze: [
        'ANALYZE: One finding per account stale > 30 days. Empty list -> single finding ("no accounts logged").',
        '',
        'Severity guide:',
        '  3 = no accounts logged yet (encourage starting)',
        '  3 = any account stale > 90 days',
        '  2 = any account stale 30-90 days',
        '  1 = all current',
        '',
        'JSON only:',
        '{"findings":[{"id":"investments-yyyymm","severity":1-5,"title":"summary","detail":"oldest accounts list","is_new":true}]}',
      ].join('\n'),
      decide: ['DECIDE: Auto-act. Reminder only.', 'JSON only: {"decisions":[{"finding_id":"id","action":"act","reason":"reminder"}],"max_severity":number}'].join('\n'),
      act: ['ACT: Telegram monthly nudge.', '  ./scripts/notify.sh "Investments log: <N> accounts stale. Update via dashboard #investments for full portfolio picture."'].join('\n'),
      report: [REPORT_DISCIPLINE].join('\n'),
    },
  },
]

// Suppress unused-var lint for chatId (used at seed time via the seed script)
void chatId
