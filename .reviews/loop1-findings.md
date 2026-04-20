# Loop 1 — Consolidated Findings

## CRITICAL

### Gates / kill switch / cost cap
- **Kill-switch client fail-OPEN on first boot** — `src/cost/kill-switch-client.ts:22-52`. `staleCache` starts `null`; on fetch error returns `null` → callers treat as "not tripped". Violates documented fail-closed semantic.
- **Gates skipped when projectId missing** — `src/agent.ts:72-93` wraps both gates in `if (gateProjectId)`. Scheduler's `learning-weekly-synthesis` bypass passes no projectId → unlimited spend + ignores kill switch.
- **Direct LLM fetches bypass gates** — `src/extraction.ts:200,219`, `src/newsletter/brief.ts:176`, `src/embeddings.ts:151`, `src/extraction/run-haiku.ts:98`. Raw `fetch` to anthropic.com / openai.com with no check.
- **Direct Telegram sends bypass gates** — `src/social-cli.ts:74`, `src/embeddings.ts:124`. Raw `fetch` to `api.telegram.org`.
- **Dashboard "Run Now" skips kill switch** — `src/scheduler.ts:666-818` (`runTaskNow`) has no `checkKillSwitch()` wrapper. Bypass paths (newsletter, security scan, metrics) call external systems directly.
- **Kill switch not re-checked between tasks / phases** — `src/scheduler.ts:297-332`, `src/paws/engine.ts`. 10-task tick at 2min each = 20min of no re-check.
- **Telegram `ctx.reply`/`ctx.editMessageText` (26 sites) bypass ChannelManager** — `src/channels/telegram.ts`.

### Paws / scheduler
- **`paw_cycles.updated_at` + `approval_requested` bad SQL in pause** — `server/src/paws-routes.ts:301-302`. Neither column exists. SET throws; swallowed by outer try/catch so stale cycle never cleared.
- **POST `/api/v1/paws` creates `next_run = 0`** — `server/src/paws-routes.ts:201-203`. New Paw fires immediately on first tick before operator can review.
- **Paw `next_run` advanced only AFTER full cycle** — `src/paws/index.ts:75-84`. Restart mid-cycle re-fires the same Paw.
- **Paw status stays stuck on `waiting_approval` after crash** — `src/paws/engine.ts:108`. `getDuePaws` excludes it; Paw silent forever.
- **Paw cycle orphaned mid-phase** — no cleanup. `getLatestCycleBefore` picks the orphan as "previous findings" → corrupted context.
- **Backlog firestorm on bot recovery** — `src/db.ts:1167-1175`, `src/paws/db.ts:142-147`. 6h outage = all missed tasks+Paws fire at once.

### Cross-project data leaks
- **GET `/api/v1/chat`** — `server/src/routes.ts:1250-1255`. `queryChatMessages` has no `allowedProjectIds`. Member without project_id gets all projects' chat events.
- **GET `/api/v1/knowledge/stats`** — `server/src/routes.ts:4044-4100`. No scoping at all. Members see all projects' entity names + observation content.
- **PATCH `/action-items/:id` with body.project_id** — `server/src/routes.ts:3755-3763`. Editor on A can move item to B without being editor on B.

### Other critical
- **Metrics `apiCache` is write-only** — `server/src/metrics-collector.ts:602-614`. `cache.set` but never `cache.get`; same integration across 2 projects = 2 API calls.
- **Action-item chat split-brain** — `server/src/routes.ts:3869, 3883`. GET reads server DB, POST writes bot DB. Writes disappear.

## HIGH

### Security / auth
- **WS bot channel: HMAC only, no BOT_API_TOKEN check** — `server/src/ws.ts:119-216`. Leak of `WS_SECRET` = full bot impersonation.
- **WS canDeliverToClient: pre-register sockets get system broadcasts** — `server/src/ws.ts:40-47`.
- **GET `/integrations` leaks all projects** — `server/src/routes.ts:2910-2917`.
- **POST `/agents/:id/heartbeat` has no auth gate** — `server/src/routes.ts:614-625`.
- **POST `/security/findings` editor-on-A can inject into B** — `server/src/routes.ts:1161-1174`.
- **GET `/dashboard/overview` lacks project scoping** — `server/src/routes.ts:1104`.
- **Dev bypass grants global admin without loopback binding** — `server/src/auth.ts:150-166`.
- **WS_SECRET fallback to empty in dev** — `server/src/auth.ts:346-402`.
- **Login cookie `Secure` flag depends on `req.secure`** — `server/src/auth.ts:433-439`.
- **Security autofixes leaks cross-project** — `server/src/routes.ts:1242-1246`.

### Paws
- **`waiting_approval` no timeout enforcement** — `src/paws/types.ts:23` declares `approval_timeout_sec`, nothing reads it.
- **Dashboard resume doesn't call computeNextRun** — `server/src/paws-routes.ts:319-331`. Stale next_run fires immediately.
- **`getLatestCycleBefore` no phase filter** — `src/paws/engine.ts:285-300`. Picks orphans/failed as "previous".
- **`processPawApproval` Telegram callback has no identity check** — `src/channels/telegram.ts:532-561`.
- **Autoupgrade runs inside scheduler tick** — `src/scheduler.ts:308-328`. Restart kills in-flight tasks.
- **cron-parser local TZ default; DST bugs** — `src/scheduler.ts:823-833`.

### Runtime / gates
- **TTL cache masks kill-switch flip for 15s; cost gate 60s** — `src/cost/kill-switch-client.ts:9`, `src/cost/cost-gate.ts:14`.
- **80% ollama override silently loses tools/MCP** — `src/agent-runtime.ts:1218-1320`. User not told.
- **Telegram no 429 retry** — `src/channels/telegram.ts` no backoff. Long messages lose chunks 3+ after 429.
- **Claude Desktop adapter swallows partial text on non-success subtypes** — `src/agent-runtime.ts:394-413`.
- **fallbackPolicy fires on ANY error** — `src/agent-runtime.ts:1326`. 4xx auth/quota trigger fallback burning next provider's quota.

### Backend
- **N+1 queries in getProjectOverview** — `server/src/db.ts:1771-1777`. 6 queries per project.
- **action-items list no LIMIT** — `server/src/routes.ts:3532-3536`.
- **`err.message` leaks SQLite errors** — `server/src/routes.ts:2201, 2324, 2336`.
- **POST /paws no 5-min minimum cron check** — `server/src/paws-routes.ts:161-212`.
- **DELETE /paws not atomic** — `server/src/paws-routes.ts:401-402`.
- **paws-sync no CHECK constraint on server status** — `server/src/db.ts:814`.
- **POST /internal/paws-sync no LIMIT on cycles array** — `server/src/paws-routes.ts:431-443`.
- **POST /security/findings no cap on findings[]** — `server/src/routes.ts:1161-1174`.

## MEDIUM / LOW

- `server/src/routes.ts:2079-2080` — `getChannelLog` NaN limit/offset silent fallback.
- `server/src/routes.ts:3560-3631` — `POST /action-items/sync` no research_item_id validation.
- `server/src/routes.ts:1988-2019` — admin-only `/costs/line-items` CRUD has no UI (CLI only? confirm).
- `server/src/routes.ts:2880-2893` — `/graph` memories query ignores project filter (admin only).
- `server/src/routes.ts:1708-1780, 1776` — POST /action-items/:id/chat/result uses body.project_id without verifying matches item's canonical project_id.
- `src/scheduler.ts:823-833` — `computeNextRun` retry loop only checks once (no while-loop).
- `src/paws/engine.ts:91-97` — DECIDE parse failure silently drops decisions (doesn't strip markdown fences).
- `src/paws/approval-card.ts:20-24` vs `src/dashboard.ts:493` — default approval_threshold=7 but max severity is 5 → no Paw ever gates.
- `src/paws/engine.ts:164` + `src/paws/index.ts:100` — resume race (two concurrent approvers).
- `server/src/ws.ts:74-296` — no cluster-mode detection; if PM2 flipped to cluster, nonce dedupe breaks.
- `src/channels/telegram.ts:182-188` — `sendVoice` doesn't send transcript for text ≤ 200 chars.
- Dashboard orphan routes: `GET /api/v1/integrations` (line 2910), `DELETE /api/v1/integrations/:id` regex (2960), `GET /themes/:id` (2106), `GET /webhooks/events` (2599). Safe to delete.
- Memory V2 observability routes have zero frontend consumers.

## Dead code / cleanup
- Paw engine.ts:133 fallback "Reply approve {pawId}" — no handler parses that format.
- Frontend: Memory V2 routes backend shipped, no dashboard page.
