⏺ FOUR OLIVES (9)

  ┌────────────────────────────────┬────────┬─────────────┬────────────────────────┐
  │               ID               │ Status │    Cron     │          What          │
  ├────────────────────────────────┼────────┼─────────────┼────────────────────────┤
  │ fop-board-meeting              │ active │ Mon 6:15    │ Orchestrator board mtg │
  ├────────────────────────────────┼────────┼─────────────┼────────────────────────┤
  │ fop-hourly-health-check        │ active │ daily 9am   │ Automation scan        │
  ├────────────────────────────────┼────────┼─────────────┼────────────────────────┤
  │ fop-monthly-newsletter         │ active │ 1st 2pm     │ Monthly newsletter     │
  ├────────────────────────────────┼────────┼─────────────┼────────────────────────┤
  │ fop-social-crossposter         │ active │ Mon+Thu 1pm │ WP→social repost       │
  ├────────────────────────────────┼────────┼─────────────┼────────────────────────┤
  │ fop-weekly-blog-draft          │ active │ Mon 1am     │ Blog draft             │
  ├────────────────────────────────┼────────┼─────────────┼────────────────────────┤
  │ fop-weekly-briefing            │ active │ Mon 4am     │ Researcher brief       │
  ├────────────────────────────────┼────────┼─────────────┼────────────────────────┤
  │ fop-weekly-content-plan        │ active │ Mon 4:45    │ Marketing plan         │
  ├────────────────────────────────┼────────┼─────────────┼────────────────────────┤
  │ fop-weekly-grant-scan          │ active │ Mon 4:05    │ Grant scan             │
  ├────────────────────────────────┼────────┼─────────────┼────────────────────────┤
  │ fop-weekly-screenplay-pipeline │ active │ Mon 4:15    │ Screenplay scan        │
  ├────────────────────────────────┼────────┼─────────────┼────────────────────────┤
  │ fop-weekly-social-report       │ active │ Mon 5am     │ Weekly social report   │
  ├────────────────────────────────┼────────┼─────────────┼────────────────────────┤
  │ fo-festival-tracker (paw)      │ active │ Tue 9am     │ Festival circuit       │
  └────────────────────────────────┴────────┴─────────────┴────────────────────────┘
  
  BROKER (24)

  Tasks (one-shot social launches):

  ┌─────────────────────────┬────────┬────────────┬────────────────┐
  │           ID            │ Status │    Cron    │      What      │
  ├─────────────────────────┼────────┼────────────┼────────────────┤
  │ paw-broker-d3-linkedin  │ active │ May 1 9am  │ D+3 LI launch  │
  ├─────────────────────────┼────────┼────────────┼────────────────┤
  │ paw-broker-d3-x         │ active │ May 1 9am  │ D+3 X launch   │
  ├─────────────────────────┼────────┼────────────┼────────────────┤
  │ paw-broker-d7-linkedin  │ active │ May 5 9am  │ D+7 LI launch  │
  ├─────────────────────────┼────────┼────────────┼────────────────┤
  │ paw-broker-d7-x         │ active │ May 5 9am  │ D+7 X launch   │
  ├─────────────────────────┼────────┼────────────┼────────────────┤
  │ paw-broker-d14-linkedin │ active │ May 12 9am │ D+14 LI (past) │
  ├─────────────────────────┼────────┼────────────┼────────────────┤
  │ paw-broker-d14-x        │ active │ May 12 9am │ D+14 X (past)  │
  └─────────────────────────┴────────┴────────────┴────────────────┘

  Paws:
  
  ┌───────────────────────────────────┬────────┬─────────────┬────────────────────┐
  │                ID                 │ Status │      Cron       │        What        │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-contractor-vendor-tracker      │ cancel │ Fri 10am        │ Contractor tracker │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-cost-seg-candidate-scan        │ cancel │ 1st 9am         │ Cost seg scan      │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-deal-pipeline-stale            │ cancel │ Tue+Fri 9am     │ Stale deal watch   │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-father-broker-pocket-feed      │ cancel │ M-F 8a+2p       │ Father broker feed │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-insurance-renewal              │ cancel │ 1st 7am         │ Insurance renewal  │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-investments-log-nudge          │ cancel │ 1st 9am         │ Investments log    │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-market-shift-watcher           │ cancel │ Wed 10am        │ Market shift       │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-material-participation-tracker │ cancel │ daily 7pm       │ REPS hours         │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-philly-ltta-renewal            │ cancel │ Q 1st 8am       │ LTTA renewal       │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-portfolio-health               │ cancel │ Mon 8am         │ Portfolio roll-up  │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-property-scout                 │ active │ Mon 8am         │ Property scout     │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-property-tax-appeal            │ cancel │ Jan+Jul 1st 8am │ Tax appeal         │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-property-weekly-digest         │ active │ Fri 7am         │ Weekly digest      │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-refi-monitor                   │ cancel │ 1st 9am         │ Refi window        │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-str-cleaning-turnover          │ cancel │ daily 10am      │ STR cleaning       │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-str-pricing-watch              │ cancel │ daily 7am       │ STR pricing        │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-tax-deadline-tracker           │ cancel │ daily 7am       │ Tax deadlines      │
  ├───────────────────────────────────┼────────┼─────────────────┼────────────────────┤
  │ re-tenant-screening-queue         │ cancel │ daily 9am       │ Tenant screening   │
  └───────────────────────────────────┴────────┴─────────────────┴────────────────────┘

  TRADER (2)
  
  ┌───────────────────────┬────────┬───────────┬────────────────┐
  │          ID           │ Status │   Cron    │      What      │
  ├───────────────────────┼────────┼───────────┼────────────────┤
  │ paw-trader-analyst    │ active │ daily 7pm │ Signal analyst │
  ├───────────────────────┼────────┼───────────┼────────────────┤
  │ trader-retrain-regime │ active │ Sun 10am  │ Regime retrain │
  └───────────────────────┴────────┴───────────┴────────────────┘

  MATTEI SYSTEMS (10)

  Tasks:
  
  ┌──────────────────────────┬────────┬──────────┬──────────────────────┐
  │            ID            │ Status │   Cron   │         What         │
  ├──────────────────────────┼────────┼──────────┼──────────────────────┤
  │ newsletter-monday        │ active │ Mon 6am  │ Asymmetry newsletter │
  ├──────────────────────────┼────────┼──────────┼──────────────────────┤
  │ newsletter-thursday      │ cancel │ Thu 6am  │ Asymmetry newsletter │
  ├──────────────────────────┼────────┼──────────┼──────────────────────┤
  │ security-weekly-audit    │ active │ Sun 8am  │ Auditor scan         │
  ├──────────────────────────┼────────┼──────────┼──────────────────────┤
  │ monday-board-meeting     │ paused │ Mon 9am  │ Board mtg            │
  ├──────────────────────────┼────────┼──────────┼──────────────────────┤
  │ youtube-linkedin-monitor │ paused │ Mon 10am │ LI engagement        │
  ├──────────────────────────┼────────┼──────────┼──────────────────────┤
  │ youtube-weekly-pipeline  │ paused │ Mon 9am  │ YT pipeline          │
  └──────────────────────────┴────────┴──────────┴──────────────────────┘
  
  Paws:

  ┌───────────────────┬────────┬─────────────┬────────────────┐
  │        ID         │ Status │    Cron     │      What      │
  ├───────────────────┼────────┼─────────────┼────────────────┤
  │ ms-channel-pulse  │ paused │ Mon+Thu 8am │ Channel pulse  │
  ├───────────────────┼────────┼─────────────┼────────────────┤
  │ ms-social-cadence │ paused │ daily 7am   │ Social cadence │
  ├───────────────────┼────────┼─────────────┼────────────────┤
  │ ms-trend-scanner  │ paused │ daily 8am   │ YT trends      │
  └───────────────────┴────────┴─────────────┴────────────────┘
  
  CLAUDEPAW INFRA (10)

  Tasks:
  
  ┌───────────────────────────┬────────┬────────────┬────────────────────────────┐
  │            ID             │ Status │    Cron    │            What            │
  ├───────────────────────────┼────────┼────────────┼────────────────────────────┤
  │ daily-backup              │ active │ weekly 6:20│ GitHub backup all projects │
  ├───────────────────────────┼────────┼────────────┼────────────────────────────┤
  │ learning-weekly-synthesis │ active │ Sun 3am    │ Skill synth                │
  ├───────────────────────────┼────────┼────────────┼────────────────────────────┤
  │ metrics-daily-collection  │ active │ daily 8am  │ Platform metrics           │
  ├───────────────────────────┼────────┼────────────┼────────────────────────────┤
  │ metric-healer             │ active │ every 6h   │ Healer routine             │
  ├───────────────────────────┼────────┼────────────┼────────────────────────────┤
  │ nightly-code-review       │ paused │ daily 2:30 │ Code review                │
  └───────────────────────────┴────────┴────────────┴────────────────────────────┘
  
  Paws:

  ┌─────────────────────────┬────────┬────────────┬────────────────────────────────┐
  │           ID            │ Status │    Cron    │              What              │
  ├─────────────────────────┼────────┼────────────┼────────────────────────────────┤
  │ claude-platform-tracker │ active │ Mon 9am    │ Claude/Anthropic release watch │
  ├─────────────────────────┼────────┼────────────┼────────────────────────────────┤
  │ sentinel-patrol         │ active │ every 4h   │ Security patrol                │
  ├─────────────────────────┼────────┼────────────┼────────────────────────────────┤
  │ cp-competitive-watch    │ paused │ Wed 9am    │ Competitive watch              │
  ├─────────────────────────┼────────┼────────────┼────────────────────────────────┤
  │ cp-oss-health           │ paused │ M/W/F 10am │ OSS repo health                │
  ├─────────────────────────┼────────┼────────────┼────────────────────────────────┤
  │ cp-community-triage     │ paused │ daily 8am  │ Community triage               │
