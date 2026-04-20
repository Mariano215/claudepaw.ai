# Loop 1 Findings — 2026-04-20

Baseline: typecheck clean, 1307/1307 tests pass.

Dispatched 10 parallel read-only review agents across: security/auth, backend+DB, frontend↔backend, paws/scheduler, runtime/gates/channels, perf, observability, migrations, config/env, telemetry.

A prior `/fullreview` session (see older `summary.md` from 2026-04-19) already addressed several CRITICAL items: kill-switch fail-closed on first boot, gates-always-run regardless of projectId, Run Now kill-switch guard, extraction/newsletter/embeddings kill-switch wiring, Paws startup reaper, Paw next_run advanced before cycle, getLatestCycleBefore phase filter, and several cross-project leaks. Those are not re-reported here.

## Genuinely new CRITICAL (fixed this loop)

- **PII logs at info**: voice transcripts (`src/channels/telegram.ts:435`), dashboard chat prompt (`src/dashboard.ts:255`), voice feed snippet — all contained user content at `info` level.
- **deleteProjectFromDb paw_cycles cascade**: `server/src/db.ts:2012` DELETEs `FROM paw_cycles WHERE project_id = ?`, but `paw_cycles` has no `project_id` column. Error swallowed; orphan cycles accumulate.
- **Server bulk-ALTER swallows ALL errors**: `server/src/db.ts:720-745` catch only logs non-duplicate-column errors without rethrowing — leaves the DB in a partial-migration state on real schema problems.
- **Messages drop project_id**: `sendMessage` at `server/src/db.ts:1115` didn't accept or write `project_id`; `messages` column defaulted to `'default'` for every dashboard-initiated reply. Cross-project misfiling.
- **Agents drop project_id on INSERT**: `upsertAgent` INSERT path at `server/src/db.ts:1079-1092` excluded `project_id` + `template_id`. Dashboard-created agents landed NULL and disappeared from per-project views.
- **WS `new_message` cross-project broadcast**: `notifyAgentMessage` used `canDeliverToClient(client, null)` → fanout to every WS client regardless of scope.
- **PATCH /research/:id body.project_id reassignment**: handler spread body over existing record, allowing editor-on-A to move the row to B without editor on B.
- **Paws `approval_timeout_sec` dead config**: declared + validated in API but never read by the reaper; stuck `waiting_approval` Paws required a bot restart to recover.
- **Cron parsed in server-local TZ**: `src/scheduler.ts` `computeNextRun` and `server/src/paws-routes.ts` `computeNextRunMs` both parsed with no TZ — DST "spring forward" skipped, "fall back" duplicated, TZ changes silently shifted all schedules.
- **No index on `agent_events(project_id, received_at)` on server DB**: the cost-gate hot-path SUM did a full table scan every runAgent call.

## Genuinely new HIGH (deferred to follow-up)

- `requireProjectRole` default resolver falls back to `req.body.project_id` — fine when handler writes to same key, footgun when it doesn't. Systematic audit needed for every route that uses the default resolver and then writes to a different project_id source.
- `ctx.reply` / `ctx.editMessageText` (~26 sites in `src/channels/telegram.ts`) bypass `ChannelManager.send` kill-switch gate and `formatForTelegram`.
- Webhook SSRF: `isInternalUrl` is hostname-literal; DNS-resolves-to-RFC1918 / CGNAT / IPv6-ULA bypasses.
- `getProjectOverview` N+1 (6 prepares per project per request).
- Many list endpoints without LIMIT (`/action-items`, `/graph`, trader reports).
- Cost-gate `triggering_cap='monthly'` when no monthly cap set (logic bug).
- Research investigate cooldown is check-then-write race.
- Kill switch not re-checked BETWEEN Paw phases (only at phase start via runAgent).
- Telegram approval-send failure → silent dead-lock (no retry / nag).
- Telegram approval callback doesn't verify approver's project role.
- 80% Ollama downshift silent (user has no idea tools/MCP disabled).
- Bot has no production boot guards for CREDENTIAL_ENCRYPTION_KEY / WS_SECRET / BOT_API_TOKEN (server does).
- `DASHBOARD_API_TOKEN` bootstrap token never revoked → perpetual admin backdoor.
- `NODE_ENV !== 'production'` is brittle vs typos / unset.
- Missing audit logs for: kill-switch trip/clear, cost-cap update, token revoke, membership grant/revoke, user CRUD, project CRUD, credential set/delete, auth login.
- No scheduled WAL checkpoint → `*-wal` files grow unbounded under launchd.
- ~60 `db.prepare()` calls inside request handlers (should be module-level).
- Multiple module-level `setInterval` with no `clearInterval` on shutdown.
- Server `users`/`user_tokens`/`project_members` schema diverges from bot DB; missing CHECK migration for `'bot'` role.
- `.env.example` missing ~25 referenced env vars.
- `claude_desktop` adapter has no cost-compute fallback when SDK omits `total_cost_usd`.

## MEDIUM / LOW
Full detail in raw agent outputs (not re-saved — single-agent files were overwritten). Priority picks deferred for next session.

## Explicitly NOT a bug (clarifications)
- **Cost-gate fail-open on outage** is documented behavior per CLAUDE.md ("Cost gate: FAIL-OPEN (allowed when unreachable)"). The asymmetry with kill-switch fail-closed is intentional.
- Several "cross-project write via body.project_id" claims verified as false alarms: the role gate and the DB write use the same body value, so the caller must have editor on the target project anyway — no bypass.
