# Loop 1 — Fixes Applied

Baseline: 1294 bot tests + 434 server tests, typecheck clean.
Post-Loop-1: **1296 bot tests + 434 server tests** (2 new fail-closed tests), typecheck clean both sides.

## Gate bypasses closed
- **`src/cost/kill-switch-client.ts`** — tracks `haveAuthoritative`. On first boot with no prior success and a network failure, returns synthetic `{reason: 'dashboard unreachable (fail-closed)'}` instead of `null`. Fixes the fail-OPEN violation of the documented fail-closed semantic. +2 new tests.
- **`src/agent.ts`** — gates no longer guarded by `if (gateProjectId)`. Kill switch always checks (global). Cost gate falls back to `'default'` when no project provided so spend is still attributed and caps still enforce.
- **`src/scheduler.ts runTaskNow`** — added `checkKillSwitch` at the top so "Run Now" from dashboard can't bypass the kill switch through the newsletter / security-scan / metrics bypass paths.
- **`src/extraction.ts extractFromConversation`** — kill switch check before the extraction LLM call (OpenAI/Anthropic/Ollama). Fail-closed.
- **`src/newsletter/brief.ts callAnthropicForBrief`** — kill switch check before the raw Anthropic call.
- **`src/embeddings.ts _openaiEmbed`** — kill switch check before the billed OpenAI call (Ollama/local paths unchanged because they're free).
- **`src/scheduler.test.ts`** — mock `./cost/kill-switch-client.js` to return null so scheduler tests are not affected by the new fail-closed semantic.

## Paws / scheduler state machine
- **`server/src/paws-routes.ts POST /paws`** — computes `next_run` from cron via a new `computeNextRunMs` helper instead of hard-coding `0` (which would fire immediately on first tick).
- **`server/src/paws-routes.ts POST /paws/:id/pause`** — fixed broken SQL that referenced non-existent columns `paw_cycles.updated_at` and `paw_cycles.approval_requested`. Now uses `completed_at` and `json_extract(state, '$.approval_requested')`. Previously the UPDATE threw and was swallowed by the outer try/catch, leaving stale decide cycles.
- **`server/src/paws-routes.ts POST /paws/:id/resume`** — recomputes `next_run` on resume so a long-paused Paw doesn't fire immediately (and join the backlog burst) when reactivated.
- **`src/paws/index.ts triggerPaw`** — advances `updatePawNextRun` BEFORE `runPawCycle` rather than in `finally`. Prevents double-fires when the bot crashes mid-cycle (previously the Paw was still immediately-due on restart).
- **`src/paws/engine.ts getLatestCycleBefore`** — filters on `phase IN ('completed', 'failed')` so orphan/partial cycles can't poison the next cycle's "previous findings" context.
- **`src/paws/db.ts reapStalePawCycles`** — new startup reaper that (a) marks in-progress phases older than 30 min as failed, and (b) unsticks Paws stuck in `waiting_approval` whose latest cycle was reaped. Wired into `initScheduler` in `src/scheduler.ts`.
- **`src/channels/telegram.ts`** — Paw approval inline-button callback now gates on `ctx.callbackQuery.from?.id` against the chat-id allowlist. Matches the trader-approval pattern. Previously anyone in the chat could click Approve.

## Cross-project leaks closed
- **`GET /api/v1/chat`** — `queryChatMessages` now takes `allowedProjectIds` (three-state: null=admin, []=empty, string[]=AND IN). Route threads scope through. Members no longer see all projects' chat events.
- **`GET /api/v1/knowledge/stats`** — full scope implementation. Entities JOINed through, observations/relations filtered by entity's project_id. Global entities (project_id IS NULL) still visible to everyone.
- **`PATCH /api/v1/action-items/:id`** — body.project_id move now requires the caller to also be at least editor on the TARGET project (not just the source). Admins still free to move anywhere.
- **`POST /api/v1/agents/:id/heartbeat`** — now `requireBotOrAdmin`. Previously any authenticated member could ping any agent id in any project (leaking pending_messages count) and writing to `updateAgentStatus`.
- **`GET /api/v1/integrations`** — `getAllProjectIntegrations` accepts `allowedProjectIds`. Members no longer see cross-project integration configs.
- **`POST /api/v1/security/findings`** — editor on project A can no longer inject per-row `project_id: "B"` (which the upsert ON CONFLICT path would use to flip real findings). Non-admins have their project_id forced to the gated value; admins unchanged. Also added a 1000-item cap on the array.
- **`GET /api/v1/security/autofixes`** — `getSecurityAutoFixes` now accepts `allowedProjectIds`. Previously a member with no project_id query param got all projects' autofixes.

## Other fixes
- **`server/src/metrics-collector.ts apiCache`** — read path wired. Before the switch-case, checks `apiCache.get(cacheKey)` and reuses. Previously the cache was write-only, doubling API quota burn for shared integrations.
- **`scripts/youtube-publish.ts`** — removed `parse_mode: 'HTML'` and HTML markup. CLAUDE.md hard rule violation.
- **`.gitignore`** — added `.reviews/` (audit artifacts per-session).

## Not fixed (intentional, Loop 2+ candidates)

- Non-claude-desktop adapters emit `total_cost_usd: null` (anthropic_api/openai_api/openrouter/codex_local paths in `src/agent-runtime.ts`). Cost cap doesn't trip for projects configured to use those. Fix needs per-adapter token→$ conversion via a provider price table. Non-trivial.
- Direct Telegram fetches in `src/social-cli.ts` and `src/embeddings.ts` alert path.
- ChannelManager `ctx.reply`/`ctx.editMessageText` (~26 sites) bypassing kill switch for Telegram-originated replies. Requires per-site rewrite or a ctx wrapper.
- Kill switch mid-cycle re-check inside Paws engine (between ODAR phases).
- Backlog firestorm: skip-missed logic on scheduler startup for old `next_run` tasks.
- WebSocket bot channel: HMAC-only auth, no BOT_API_TOKEN tie-in.
- WebSocket `canDeliverToClient`: pre-register sockets receive system broadcasts.
- Dashboard `/dashboard/overview` lacks project scoping (returns cross-project overview to any member).
- Dev-mode `ALLOW_UNAUTHENTICATED_DASHBOARD=1` grants admin without loopback binding.
- `CREDENTIAL_ENCRYPTION_KEY` format/length not validated on server boot. Not in `.env.example`.
- Bot-side `src/index.ts` has no env-validation layer.
- `DASHBOARD_URL` hardcoded Tailscale IP fallback in `src/channels/telegram.ts:608`.
- Audit log: no entries for login/logout, user mutation, cost cap update, plugin toggle.
- No `audit_log` table — all security-critical events go to stdout only.
- Pino loggers lack `redact: { paths: [...] }` config.
- Server-side `projects` table is a shell `(id, name)` while bot-side has `slug/display_name/icon/status/...`.
- Server-side `paws_cycles` missing FK + index.
- `server/src/db.ts:1960` typo `'costs_line_items'` in project-delete cascade list.
- `cost_gate` cache (`src/cost/cost-gate.ts`) grows unbounded by project_id (no eviction).
- WhatsApp listener leak on reconnect (`src/channels/whatsapp.ts:61-105`).
- Scheduler Paws + tasks Promise.allSettled with no concurrency cap.
- server routes.ts re-prepares statements on every request in hot paths (e.g. `/projects/overview` N+1 queries).
- Log noise: info-level logs in scheduler tick, WS connect/disconnect, kill-switch client failure flood.
