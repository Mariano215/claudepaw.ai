# Changelog

All notable user-facing changes to this project should be recorded here.

This file follows a lightweight Keep a Changelog style and is intended for humans first. Commits can stay technical; this file should summarize what users, contributors, and future-you care about.

## Unreleased

### Added
- Immediate acknowledgement message ("Got it, working on it...") sent to the user right after routing, before the agent runs — so a mid-run restart no longer leaves the user with zero feedback.
- Ollama embeddings now fall back to OpenAI `text-embedding-3-small` when Ollama is unreachable (HTTP 4xx/network error). Requires `OPENAI_API_KEY` to be set. Falls back to empty vector if neither succeeds.
- Empty agent responses now include a descriptive reason (subtype, turn count, tool count, duration) instead of the generic `(No response from Claude)` placeholder, matching the detail level already present in scheduler failure messages.

### Added (previous)
- `/api/v1/health` now reports `status: "degraded"` with a `warnings` array when critical env vars (`CREDENTIAL_ENCRYPTION_KEY`, `WS_SECRET` in prod, `DASHBOARD_API_TOKEN`) are missing, so misconfiguration is visible instead of silent.
- Rate limiting on `/api/v1` (300 req/min per IP general, 30 req/min for `/tasks/:id/run` since each triggers an agent spawn) and per-client WebSocket rate limiting (60 msg/min, bot client exempt).
- Provider fallback chain is now configured for all projects: `claude_desktop` primary with `anthropic_api` as the automatic fallback, so errors like `error_max_turns` in Claude Desktop no longer kill the task.

### Security
- Telegram bot allowlist is now fail-closed: an empty allowlist rejects all messages with an error log instead of accepting everyone. Set `ALLOWED_CHAT_ID` in `.env` or per-project credentials.
- OAuth return-url redirects are now origin-validated against the server's own host to prevent open-redirect abuse from crafted `return_url` parameters.
- Agent file resolution in `resolveAgentFilePath()` now enforces a strict `[a-z0-9-]`/`project--template` regex and asserts the resolved path stays under `PROJECT_ROOT` (explicit path-traversal defense on top of the existing implicit check).
- Missing `CREDENTIAL_ENCRYPTION_KEY` now aborts server startup by default. Set `ALLOW_MISSING_CREDENTIAL_KEY=1` to downgrade to a warning for local/dev runs.
- Removed the hardcoded personal Telegram chat ID fallback in `social-cli.ts notify`; requires an explicit chat ID or `DEFAULT_NOTIFY_CHAT_ID` env var.
- Google OAuth token refresh no longer marks an integration `disconnected` on transient network errors; only hard auth failures (`invalid_grant`, token revoked) flip the flag. Transient failures fall back to the existing token and log a warning.

### Changed
- Updated repo docs with a clearer command cheat sheet for commit, push, deploy, OSS sync, and Paw Trader mirror sync workflows.
- Migrated local TTS defaults, setup docs, dashboard labels, and content guidance from Voxtral on port 8091 to Chatterbox on port 8095 using the new `/v1/tts` `{text, voice}` API with `default` as the default voice.
- Scheduled task prompts are now prefixed with a preamble instructing agents to skip `git status`/`git diff` and not ask about uncommitted changes, which was previously stalling `newsletter-monday` and `security-weekly-audit` runs.
- `augmentTaskPrompt()` in the scheduler catches auth/token errors from context builders and runs the task with a degraded-context note instead of killing the whole run.
- SDK `query()` `maxTurns` raised from 25 to 50 for the `anthropic_api` execution path, reducing spurious mid-task failures on complex multi-step agents.
- New projects now seed a generic agent roster by default instead of inheriting the Default Project project-specific lineup.
- Chat-to-project routing is now keyed by channel-qualified chat identity, preventing cross-channel project collisions when raw chat IDs overlap.
- Document meaningful behavior changes, refactors with visible impact, or updated defaults.
- Tightened Telegram notifications so scheduled runs stay quiet unless they hit an error, surface an issue, or create action items to review.
- Example Company weekly briefing, content-plan, and festival-scan tasks now receive structured Gmail, calendar, and sheet context from the scheduler before the model runs, instead of relying on in-prompt shell commands.

### Fixed
- Fixed Paw Trader alert spam by suppressing blind low-score signals before they page the operator and cooling down repeat alerts after a recent committee veto on the same asset/strategy.
- Fixed Paw Trader committee rationale calibration so risk/trader explanations now see the configured score floor and stop labeling valid low-end signals as "noise" without threshold context.
- Fixed `cp-competitive-watch` false alarms by moving it onto a deterministic feed collector and only approval-gating new findings that cite evidence URLs from the current observation set.
- Blocked dashboard `Run Now` on paws already waiting for approval and hardened paw finding dedupe so previously surfaced items stay known unless they return at higher severity.
- Fixed Paw reliability so approval timeouts resume on the next scheduled cron instead of re-firing immediately, empty paw phases now retain the runtime diagnostic reason in the stored error, and `paw-retry` skips non-transient failures like no-text responses and known code bugs.
- Fixed Paw Trader signal ingestion so the brain no longer drops most live engine candidates behind an overly strict local `0.5` score floor; the default now matches the engine’s `0.05` strategy floor and logs fetched/stored/filtered counts for easier diagnosis.
- Fixed scheduled social post reliability for Facebook/Instagram by repairing legacy `social_posts` rows with missing IDs at startup, enforcing non-null social post IDs in schema rebuilds, and surfacing a specific corruption error instead of the generic `Unknown error`.
- Fixed dashboard WebSocket `new_message` handler reading `msg.data` when the backend sends `msg.message` + `msg.agentId`. Real-time chat updates in the dashboard now render correctly again.
- Fixed the dashboard "Run Now" chat path stale-placeholder bug so failed runs now return a descriptive message instead of the old `[No response from agent]` literal (the scheduler paths were already fixed earlier).
- Removed dead `feed_item` WebSocket handler in the frontend that was never triggered (server receives `feed_item` from the bot and re-emits as `feed_update`, which the frontend already handles).
- Deleted the broken `daily-repo-backup` scheduled task, which was writing setup documentation instead of running a backup. `daily-backup` (6:20am) continues to perform the actual backup work.
- Locked down dashboard API authentication so production no longer fails open when `DASHBOARD_API_TOKEN` is missing.
- Synced dashboard-managed project credentials and OAuth tokens down to the live bot, so connected integrations like Google are usable immediately by task runs instead of appearing connected only in the dashboard.
- Scoped webhook delivery to the owning project and stopped exposing webhook secrets in dashboard API responses.
- Stopped cross-project fallback in the YouTube metrics proxy so project dashboards only use their own configured credentials.
- Fixed the Action Plan dashboard to read the main bot database from the repo-level `store/claudepaw.db` by default, so Telegram notifications about newly proposed items line up with what the dashboard actually shows.
- Fixed Action Plan drift between the local bot and hosted dashboard by syncing action items to the dashboard on bot connect and after item changes, and hardened startup so a corrupted local `telemetry.db` is quarantined and rebuilt instead of crashing ClaudePaw.
- Fixed deploy/database durability by stopping normal deploys from overwriting live local SQLite files with production copies, archiving production DB pulls into `store/prod-snapshots/`, and checkpointing local SQLite databases during shutdown.
- Fixed the Security score gauge sizing so it stays properly scaled on high-DPI and mobile screens instead of rendering oversized.
- Restored dashboard chat delivery by aligning the WebSocket message type with the bot listener and preserving the selected project context for provider-switch testing.
- Fixed execution waterfall fallback triggered via runtime overrides and `provider:smoke`, including legacy policy aliases like `auto_on_error`.
- Fixed dashboard and channel logging so failed chat runs now emit visible error entries with provider fallback context instead of disappearing from the UI.
- Removed HTML parse mode from the shell notifier so every Telegram path follows the project's plain-text-only rule.
- Fixed guard sidecar startup so it recreates stale Python virtualenvs, reports ML init failures as health errors instead of hanging in `loading`, and loads Nova rules through the installed package layout.
- Added a repo-local Nova starter ruleset and a `test:guard:rules` harness for validating prompt-injection detections against blocked and benign samples.
- Added a hard timeout to Claude Desktop agent runs so scheduled jobs fail over cleanly instead of sitting at `running...` indefinitely.
- Normalized Claude runtime working directories to the repo root so local provider runs can resolve ClaudePaw assets and integration CLIs consistently.
- Removed stale `ubuntu-mbp` references from live config and dashboard mock data now that ClaudePaw runs on the Mac-hosted workspace.
### Removed
- Document removed features, deprecated paths, or breaking cleanup.

## Release Process

1. Add notable changes to `Unreleased` as work lands.
2. When ready to publish, copy `Unreleased` into a dated version section like `## v0.1.0 - 2026-04-08`.
3. Clear `Unreleased` back to empty headings.
4. Create and push the tag for that version.
5. Create a GitHub Release using the same summary.

## Example

## v0.1.0 - 2026-04-08

### Added
- Initial Telegram bot workflow.
- Dashboard live status updates.

### Changed
- Improved local execution provider selection.

### Fixed
- Reduced startup failures during setup.
