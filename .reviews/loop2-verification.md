# Loop 2 — Verification + additional fixes

## Loop 1 verification (17 items, all VERIFIED ✓)

A single verification agent re-read every file Loop 1 touched and confirmed:

1. Kill-switch fail-closed on first boot — `haveAuthoritative` tracking + synthetic tripped return ✓
2. Gates always run regardless of projectId (default='default') ✓
3. POST /paws: computeNextRunMs(cron), pause SQL json_extract, resume recomputes next_run ✓
4. Paw next_run advanced BEFORE cycle ✓
5. `getLatestCycleBefore` filters phase IN ('completed','failed') ✓
6. `reapStalePawCycles` exported + wired into initScheduler ✓
7. Paw Telegram approval checks ctx.from.id against allowlist ✓
8. `runTaskNow` checks kill switch at TOP ✓
9. GET /chat threads allowedProjectIds ✓
10. GET /knowledge/stats scopes entities by project_id IN allowed (globals still visible) ✓
11. PATCH /action-items validates target project role on move ✓
12. POST /agents/:id/heartbeat requireBotOrAdmin ✓
13. GET /integrations threads allowedProjectIds ✓
14. POST /security/findings: 1000-item cap, per-row project_id forced for non-admins ✓
15. GET /security/autofixes threads allowedProjectIds ✓
16. GET /dashboard/overview threads allowedProjectIds ✓
17. `queryChatMessages`, `getAllProjectIntegrations`, `getSecurityAutoFixes`, `getProjectOverview` all three-state scope ✓
18. `metrics-collector.ts apiCache.get` called before the switch ✓
19. `youtube-publish.ts` parse_mode removed, HTML tags stripped ✓
20. Extraction, newsletter brief, OpenAI embed — all kill-switch guarded, fail-closed ✓
21. kill-switch-client tests include new fail-closed test + stale not-tripped test ✓

**No new issues introduced** by the Loop 1 edits. Route signature additions are all optional params with null/undefined defaults — no test-mock breakage.

## Loop 1.5 — additional fixes applied after verifier report

### Telemetry / cost attribution (CRITICAL)
- **`src/cost/pricing.ts`** — new price table (Claude Sonnet 4/Haiku/Opus, GPT-5/5.4/mini, gpt-4o family, Ollama/LM-Studio free) + `computeCostUsd(model, usage)` helper with family fuzzy-match.
- **`src/cost/pricing.test.ts`** — 10 new tests covering Ollama-free path, family matching, unknown-model null return, and exact cost arithmetic.
- **`src/agent-runtime.ts`** — wired `computeCostUsd` into the three adapter emit points that previously hard-coded `total_cost_usd: null`:
  - `anthropicApiAdapter` success path (line 930)
  - `openaiApiAdapter` success path (line 1188)
  - `chatCompletionsAdapter` (ollama/openrouter/lm_studio) success path (line 1297)
- Impact: cost cap now actually trips for projects configured with `anthropic_api`, `openai_api`, `openrouter`, `codex_local`. Previously these all emitted null → SUM(total_cost_usd)=$0 → 80%/100% thresholds never fired.

### Backlog firestorm (HIGH)
- **`src/db.ts getBacklogTasks(maxAgeMs)`** — new helper returning scheduled tasks whose next_run is more than N minutes stale.
- **`src/paws/db.ts getBacklogPaws`** — same for Paws.
- **`src/scheduler.ts initScheduler`** — on startup, advance `next_run` on all backlog tasks + Paws to the next future occurrence without firing them. Tunable via `SCHEDULER_MAX_BACKLOG_MS` (default 15 min).
- Impact: bot resumes after an overnight outage without the "fire 20 missed cron jobs at once" stampede. Logged at warn level so operator sees the skip count.

### Config + env (HIGH)
- **`server/src/env.ts`** — added AES-256-GCM key format validation. `CREDENTIAL_ENCRYPTION_KEY` must be 64 hex chars; fails loud on boot if not. Catches the common "pasted `openssl rand -base64 32` (44 chars) instead of hex-32" mistake.
- **`.env.example`** — added `CREDENTIAL_ENCRYPTION_KEY` entry with generation instructions.
- **`server/src/index.ts`**:
  - `DASHBOARD_JWT_SECRET` missing in production now **exits 1** (was warn-only, causing silent OAuth failures weeks later).
  - `ALLOW_UNAUTHENTICATED_DASHBOARD=1` in production now **exits 1** (safety guard against dev .env being copied to prod).

### Memory / cache bounds (MEDIUM)
- **`src/cost/cost-gate.ts`** — cache now has a 100-entry cap with opportunistic eviction on cache-miss. Prunes expired entries first, then evicts oldest. Prevents unbounded growth over long uptimes.

### Cleanup
- **`server/src/db.ts:2012`** — removed `'costs_line_items'` typo from project-delete cascade (table is actually `cost_line_items` but it has no `project_id` column so it shouldn't be in the list anyway — removed).

## Test status

Baseline: 1294 bot tests, 434 server tests.
Final: **1306 bot tests + 434 server tests** (baseline + 10 pricing + 2 kill-switch fail-closed). All green. Typecheck clean both sides.

## Still outstanding (for future loops)

The verifier's outstanding list (unchanged from Loop 1 except where fixed above):

- Direct Telegram fetches in `src/social-cli.ts` and `src/embeddings.ts` alert path (Telegram).
- ~26 `ctx.reply` / `ctx.editMessageText` sites bypass kill switch.
- Kill switch mid-cycle re-check inside Paws engine (between ODAR phases).
- WebSocket bot channel HMAC-only (no BOT_API_TOKEN tie-in).
- WebSocket `canDeliverToClient` pre-register sockets receive system broadcasts.
- No audit_log table (security-critical events stdout-only).
- Pino loggers lack `redact` config.
- Server-side `projects` schema mismatch with bot DB.
- WhatsApp listener leak on reconnect.
- No concurrency cap on Paws/tasks `Promise.allSettled`.
- N+1 query hot paths in `/projects/overview`.

These require more surgical work or new infrastructure (audit table, redact config). Ready for a `/fullreview --loops 3` run next session.
