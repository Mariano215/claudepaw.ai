# ClaudePaw

An open-source, self-hosted AI platform that turns your Claude subscription into a team of specialized agents.

## Architecture

- **Bot**: TypeScript, runs as a persistent service (launchd on macOS, systemd on Linux)
- **Dashboard**: Express + WebSocket server, single-page frontend
- **Database**: SQLite with WAL mode, FTS5 for memory search
- **Channels**: Telegram (built-in), Discord, WhatsApp, Slack, iMessage (plugin channels)

## Project Structure

```
src/                    # Bot core
  index.ts              # Bootstrap and lifecycle
  agent.ts              # Claude Code SDK wrapper
  pipeline.ts           # Message processing pipeline
  agent-router.ts       # Intent-based agent routing
  souls.ts              # Agent definition loader
  db.ts                 # SQLite database
  memory.ts             # FTS5 semantic memory
  scheduler.ts          # Cron task scheduler
  config.ts             # Environment config
  channels/             # Messaging platform adapters
  guard/                # 7-layer security chain
  security/             # Vulnerability scanners
  plugins/              # Plugin loader and registry
  webhooks/             # Event webhook dispatcher
server/
  src/                  # Dashboard backend (Express + WebSocket)
  public/               # Dashboard frontend (SPA)
  themes/               # Color theme definitions
agents/                 # Global agent definitions (YAML + markdown)
templates/              # Agent templates for new projects
projects/               # Per-project agent overrides
plugins/                # Installed plugins
scripts/                # Setup, deploy, and utility scripts
```

## Key Concepts

### Agents
Agents are defined as markdown files with YAML frontmatter. Each has: id, name, emoji, role, mode (always-on/active/on-demand), keywords, and capabilities. The body is the system prompt.

### Multi-Project
Each project has its own agents, integrations, theme, and data scope. Agent lookup: `projects/{slug}/agents/` first, falls back to `agents/`. Switch with `/switch` command.

### Guard System
7-layer security chain: L1 sanitize, L2 regex scan, L3 Nova rules (sidecar), L4 ML input (sidecar), L5 canary injection, L6 output validation, L7 ML output scan.

### Memory
FTS5-powered semantic memory with salience scoring and time-based decay. Memories tagged by sector (semantic/episodic) and scoped per project.

### Scheduler
Cron-based task scheduler. Polls every 60s. Tasks execute via the agent SDK with full tool access.

## Timestamps

All timestamps use milliseconds (matching `Date.now()`). Never divide by 1000 when storing.

## Deploy

- `npm run deploy` -- Full pipeline: typecheck, test, build, commit, push, deploy dashboard, restart bot
- `npm run restart` -- Quick: build, deploy dashboard, restart bot
- `npm run deploy:dashboard` -- Dashboard only

Set `DASHBOARD_HOST` and `DASHBOARD_DIR` environment variables for remote deployment.

## Setup

```bash
npm install
npm run setup    # Interactive wizard
npm run build
npm start
```

## Development

```bash
npm run dev      # Run with tsx (hot reload)
npm test         # Run tests
```
