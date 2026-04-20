# Loop 1 — Fixes Applied

## Session 2026-04-20 (this run)

Baseline + post state: typecheck clean; 117 test files, 1307 tests, all passing both before and after.

### Tenant isolation
- `server/src/db.ts:sendMessage` — accepts `projectId` param and writes to `messages.project_id`; `POST /messages` (`server/src/routes.ts`) threads `body.project_id` through. Dashboard replies now land on the correct project.
- `server/src/db.ts:upsertAgent` INSERT path — adds `project_id` + `template_id` columns (defaulted to `'default'` + agent id). Dashboard-created agents now visible in per-project views.
- `server/src/ws.ts:notifyAgentMessage` — scopes WS fanout by `message.project_id` instead of broadcasting `null` to every client.
- `server/src/routes.ts` `PATCH /research/:id` — strips `project_id` from body before upsert. Prevents editor-on-A moving the row to B without editor on B.

### Schema / DB integrity
- `server/src/db.ts:deleteProjectFromDb` — `paw_cycles` cascade now uses `WHERE paw_id IN (SELECT id FROM paws WHERE project_id = ?)` (the column never existed; the prior DELETE silently errored and orphan cycles accumulated).
- `server/src/db.ts` bulk ALTER block — only swallows `"duplicate column"` (re-run case); rethrows every other error so real schema problems fail boot loudly instead of logging-and-continuing into a partial-migration state.
- `server/src/db.ts` telemetry.db init — adds `CREATE INDEX IF NOT EXISTS idx_agent_events_project_time ON agent_events(project_id, received_at)`. Cost-gate SUM hot-path no longer full-scans.

### Paws
- `src/paws/db.ts:reapStalePawCycles` — honors per-Paw `approval_timeout_sec` (default 1h). A `waiting_approval` Paw whose latest cycle is still in the `decide` phase but has aged past its timeout is now explicitly reaped (with a clear error message) and the Paw is flipped back to `active`.
- `src/scheduler.ts:runDueTasks` — calls `reapStalePawCycles` on every tick, not just at startup. Approval timeouts take effect within one scheduler tick without a bot restart.
- `src/scheduler.ts:computeNextRun` + `server/src/paws-routes.ts:parseCron` — both pin TZ via `CRON_TZ` env var (default `America/New_York`). DST "spring forward" skip, "fall back" duplicate, and host-TZ changes no longer silently shift schedules. `computeNextRun` fallback also converted from single retry to `while` loop.

### PII / logging
- `src/channels/telegram.ts` voice transcript: `info` log carries `{chatId, length}` only; raw transcript body moved to `debug`. Feed snippet uses `${length} chars`, not content.
- `src/dashboard.ts` dashboard chat message: `info` log carries `{chatId, projectId, textLen}` only; prompt body moved to `debug`.

### Files touched (8)
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

### Verification
- `npm run typecheck` → 0 errors.
- `npm test` → 117 test files, 1307 tests, all passing. No regressions.

---

## Session 2026-04-19 (prior run — retained for history)

Baseline: 1294 bot tests + 434 server tests, typecheck clean.
Post-Loop-1: **1296 bot tests + 434 server tests** (2 new fail-closed tests), typecheck clean both sides.

### Gate bypasses closed
- **`src/cost/kill-switch-client.ts`** — tracks `haveAuthoritative`. On first boot with no prior success and a network failure, returns synthetic `{reason: 'dashboard unreachable (fail-closed)'}` instead of `null`. Fixes the fail-OPEN violation of the documented fail-closed semantic. +2 new tests.
- **`src/agent.ts`** — gates no longer guarded by `if (gateProjectId)`. Kill switch always checks (global). Cost gate falls back to `'default'` when no project provided so spend is still attributed and caps still enforce.
- **`src/scheduler.ts runTaskNow`** — added `checkKillSwitch` at the top so "Run Now" from dashboard can't bypass the kill switch through the newsletter / security-scan / metrics bypass paths.
- **`src/extraction.ts extractFromConversation`** — kill switch check before the extraction LLM call (OpenAI/Anthropic/Ollama). Fail-closed.
- **`src/newsletter/brief.ts callAnthropicForBrief`** — kill switch check before the raw Anthropic call.
- **`src/embeddings.ts _openaiEmbed`** — kill switch check before the billed OpenAI call (Ollama/local paths unchanged because they're free).
- **`src/scheduler.test.ts`** — mock `./cost/kill-switch-client.js` to return null so scheduler tests are not affected by the new fail-closed semantic.

### Paws / scheduler state machine
- **`server/src/paws-routes.ts POST /paws`** — computes `next_run` from cron via a new `computeNextRunMs` helper instead of hard-coding `0` (which would fire immediately on first tick).
- **`server/src/paws-routes.ts POST /paws/:id/pause`** — fixed broken SQL that referenced non-existent columns `paw_cycles.updated_at` and `paw_cycles.approval_requested`. Now uses `completed_at` and `json_extract(state, '$.approval_requested')`. Previously the UPDATE threw and was swallowed by the outer try/catch, leaving stale decide cycles.
- **`server/src/paws-routes.ts POST /paws/:id/resume`** — recomputes `next_run` on resume so a long-paused Paw doesn't fire immediately (and join the backlog burst) when reactivated.
- **`src/paws/index.ts triggerPaw`** — advances `updatePawNextRun` BEFORE `runPawCycle` rather than in `finally`. Prevents double-fires when the bot crashes mid-cycle.
- **`src/paws/engine.ts getLatestCycleBefore`** — filters on `phase IN ('completed', 'failed')` so orphan/partial cycles can't poison the next cycle's "previous findings" context.
- **`src/paws/db.ts reapStalePawCycles`** — startup reaper marks in-progress phases older than 30 min as failed, and unsticks Paws stuck in `waiting_approval` whose latest cycle was reaped. Wired into `initScheduler`.
- **`src/channels/telegram.ts`** — Paw approval inline-button callback now gates on `ctx.callbackQuery.from?.id` against the chat-id allowlist. Matches the trader-approval pattern.

### Cross-project leaks closed
- **`GET /api/v1/chat`** — `queryChatMessages` takes `allowedProjectIds` (three-state convention).
- **`GET /api/v1/knowledge/stats`** — scope threaded through.
- **`PATCH /api/v1/action-items/:id`** body.project_id move requires editor on TARGET too.
- **`POST /api/v1/agents/:id/heartbeat`** — now `requireBotOrAdmin`.
- **`GET /api/v1/integrations`** — `getAllProjectIntegrations` accepts `allowedProjectIds`.
- **`POST /api/v1/security/findings`** — non-admins have project_id forced to gated value; 1000-item cap.
- **`GET /api/v1/security/autofixes`** — `getSecurityAutoFixes` accepts `allowedProjectIds`.

### Other fixes
- **`server/src/metrics-collector.ts apiCache`** — read path wired. Previously write-only.
- **`scripts/youtube-publish.ts`** — removed `parse_mode: 'HTML'`.
- **`.gitignore`** — added `.reviews/`.
