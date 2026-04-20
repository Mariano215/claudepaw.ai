# /fullreview — Session Summary

## Run 2026-04-20 (this session)

Baseline: typecheck clean, 117 test files, 1307 tests passing.
Final: same — 117 test files, 1307 tests passing, typecheck clean. **Zero regressions.**

### Loops run

- **Loop 1** — Dispatched 10 parallel read-only review agents across security/auth, backend+DB, frontend↔backend, paws/scheduler, runtime/gates/channels, perf, observability, migrations, config/env, telemetry. Consolidated findings, de-duped against the prior `/fullreview` session (2026-04-19 — see older entry below), and applied fixes.
- **Loop 2** — Dispatched a single regression-check agent scoped to the 8 files touched in Loop 1. Report: zero CRITICAL, zero HIGH regressions. Stopped per skill's early-stop rule.

### Fixes applied (8 files)

**Tenant isolation**
- Messages now persist `project_id` (bot DB `sendMessage` signature extended; `POST /messages` threads body.project_id).
- `upsertAgent` INSERT branch now writes `project_id` + `template_id` (dashboard-created agents were landing NULL).
- WS `notifyAgentMessage` scopes fanout by `message.project_id` (was broadcasting `null` to all clients).
- `PATCH /research/:id` strips `project_id` from body (prevents editor-on-A moving the row to B).

**Schema / DB**
- `deleteProjectFromDb` paw_cycles cascade uses `paw_id IN (SELECT id FROM paws WHERE project_id = ?)` (the column never existed; prior error was silently swallowed).
- Bulk ALTER block rethrows non-"duplicate column" errors instead of logging-and-continuing.
- New `idx_agent_events_project_time` index on server telemetry.db (cost-gate hot path no longer full-scans).

**Paws**
- `reapStalePawCycles` now honors per-Paw `approval_timeout_sec` (default 1h); timed-out `waiting_approval` Paws get unstuck automatically.
- Reaper now runs on every scheduler tick (was startup-only) so approval timeouts take effect within 60s without a restart.
- Cron parser pins TZ via `CRON_TZ` env var (default `America/New_York`); both `src/scheduler.ts` and `server/src/paws-routes.ts`. Fixes DST / host-TZ bugs.

**PII / logging**
- Voice transcript moved from info-level log to debug; info retains chatId + length only.
- Dashboard chat prompt moved from info to debug; info retains chatId + projectId + textLen.
- Feed snippet for voice now `${length} chars` (was 60 chars of content).

### Files touched
```
server/src/db.ts
server/src/paws-routes.ts
server/src/routes.ts
server/src/ws.ts
src/channels/telegram.ts
src/dashboard.ts
src/paws/db.ts
src/scheduler.ts
```

### Outstanding HIGH items (handed off — not fixed this session)

Documented in `loop1-findings.md`. Highest leverage for next session:

1. `requireProjectRole` default resolver body fallback — systematic audit of all routes using the default resolver vs their write paths.
2. `ctx.reply` / `ctx.editMessageText` in `src/channels/telegram.ts` (~26 sites bypass ChannelManager kill-switch gate + formatForTelegram).
3. Bot-side production boot guards (CREDENTIAL_ENCRYPTION_KEY / WS_SECRET / BOT_API_TOKEN) — server has them, bot doesn't.
4. `NODE_ENV` allowlist at boot (prevents typos from disabling prod guards).
5. Audit log table + entries for kill-switch trip/clear, cost-cap update, token revoke, membership grant/revoke, user/project CRUD, credential set/delete, auth login.
6. pino redact config (chatId, token, transcript, text, email, authorization).
7. Webhook SSRF hardening (DNS re-resolve before delivery; block CGNAT + IPv6 ULA).
8. Scheduled WAL checkpoint (`*-wal` files grow unbounded).
9. Hoist hot `db.prepare()` calls out of route handlers (`/action-items/:id`, `/dashboard` counts, etc.).
10. `claude_desktop` adapter cost-compute fallback when SDK omits `total_cost_usd`.

### Suggested follow-up tests (from Loop 2 regression agent)
- `CRON_TZ` pinning assertion (force UTC in test, assert returned timestamp is UTC-9am for `0 9 * * *`).
- `computeNextRun` clock-skew while-loop fallback.
- `reapStalePawCycles` approval-timeout path (create waiting_approval + decide-phase cycle aged past timeout, assert unstick).
- `sendMessage` project_id persistence (current test mocks the function; real DB write is uncovered).
- `notifyAgentMessage` project scoping (WS fanout).

### Loop 2 minor MED/LOW findings (deferred)
- `reapStalePawCycles` measures timeout from `cycle.started_at`, not from when DECIDE paused. Record `approval_requested_at` in cycle state for more accurate timeout semantics.
- Reaper's `stuck` query lacks secondary tiebreak (`rowid DESC`) — collision only possible at same-ms insert which `runningPaws` already prevents, but worth aligning with `getLatestCycle`'s sort.
- Mid-tick reaper runs every 60s; fine today but worth gating if waiting_approval count ever grows large.

---

## Run 2026-04-19 (prior session — retained for history)

Baseline: 1294 bot tests + 434 server tests passing, typecheck clean.
Final: **1296 bot tests + 434 server tests passing**, typecheck clean both sides.

### What ran

10 review agents in parallel across two waves:

**Wave 1 (5 agents):**
1. Security / auth / permissions / tokens
2. Backend routes + DB code quality
3. Frontend ↔ backend contract sync
4. Paws + scheduler / cronjobs
5. Agent runtime / gates / channels

**Wave 2 (5 agents):**
6. Performance + resource leaks
7. Observability + logging
8. Migration + schema safety
9. Config + env validation
10. Telemetry + cost attribution

Each agent was read-only. Coordinator consolidated findings and applied fixes.

### Fixes applied (20 direct file changes)

**Gate bypasses closed**
- Kill-switch fail-CLOSED on first boot (`src/cost/kill-switch-client.ts` + 2 tests)
- Gates always run regardless of projectId (`src/agent.ts`)
- Dashboard "Run Now" honors kill switch (`src/scheduler.ts`)
- Extraction pipeline honors kill switch (`src/extraction.ts`)
- Newsletter brief honors kill switch (`src/newsletter/brief.ts`)
- OpenAI embed honors kill switch (`src/embeddings.ts`)
- YouTube publish: removed Telegram `parse_mode: 'HTML'` violation (`scripts/youtube-publish.ts`)

**Paws / scheduler state machine**
- POST /paws computes `next_run` from cron instead of 0 (`server/src/paws-routes.ts`)
- Pause SQL fixed: uses `json_extract` + correct columns (`server/src/paws-routes.ts`)
- Resume recomputes `next_run` to avoid immediate fire on reactivation (`server/src/paws-routes.ts`)
- Paw `next_run` advanced BEFORE cycle not after (`src/paws/index.ts`)
- `getLatestCycleBefore` filters on `phase IN ('completed','failed')` (`src/paws/engine.ts`)
- Startup reaper: `reapStalePawCycles` wired into `initScheduler` (`src/paws/db.ts` + `src/scheduler.ts`)
- Telegram Paw approval inline-button checks `from.id` against allowlist (`src/channels/telegram.ts`)

**Cross-project data + write leaks closed**
- GET /chat threads allowedProjectIds through
- GET /knowledge/stats scoped by entity project_id (global entities still visible)
- PATCH /action-items body.project_id requires editor on TARGET project too
- POST /agents/:id/heartbeat now `requireBotOrAdmin` (was unauthenticated-at-role)
- GET /integrations scoped by allowedProjectIds
- POST /security/findings: non-admins can't inject per-row project_id; 1000-item cap
- GET /security/autofixes scoped
- GET /dashboard/overview scoped

**Infrastructure**
- Metrics `apiCache` read path wired (`server/src/metrics-collector.ts`)
- `.reviews/` added to `.gitignore`
