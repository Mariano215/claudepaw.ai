#!/bin/bash
# Rebuild and restart ClaudePaw (bot + dashboard)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST="$HOME/Library/LaunchAgents/com.claudepaw.app.plist"
DASHBOARD_HOST="${DASHBOARD_HOST:-root@localhost}"
DASHBOARD_DIR="${DASHBOARD_DIR:-/opt/claudepaw-server}"

cd "$PROJECT_DIR"

# --- 1. Build bot ---
echo "Building bot..."
npx tsc || { echo "Build failed"; exit 1; }
echo "✓ Bot build OK"

# --- 2. Deploy dashboard to Hostinger ---
echo "Deploying dashboard..."
rsync -az --delete \
  server/public/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/public/" \
  && echo "✓ Dashboard public deployed" \
  || echo "⚠ Dashboard public deploy failed (non-fatal)"

rsync -az --delete \
  server/src/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/src/" \
  && echo "✓ Dashboard src deployed" \
  || echo "⚠ Dashboard src deploy failed (non-fatal)"

rsync -az --delete \
  server/themes/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/themes/" \
  && echo "✓ Dashboard themes deployed" \
  || echo "⚠ Dashboard themes deploy failed (non-fatal)"

rsync -az \
  server/package.json server/tsconfig.json \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/" \
  && echo "✓ Dashboard config deployed" \
  || echo "⚠ Dashboard config deploy failed (non-fatal)"

# Sync pm2 ecosystem file (fork mode is pinned here -- see CLAUDE.md)
rsync -az \
  ecosystem.config.cjs \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/" \
  && echo "✓ Ecosystem config deployed" \
  || echo "⚠ Ecosystem config deploy failed (non-fatal)"

# Rebuild + restart server on Hostinger (pm2 fork mode -- never cluster)
ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" \
  "cd $DASHBOARD_DIR && npm install 2>/dev/null && npx tsc 2>/dev/null && fuser -k 3000/tcp 2>/dev/null; sleep 1; pm2 startOrRestart ecosystem.config.cjs 2>/dev/null; pm2 save 2>/dev/null" \
  && echo "✓ Dashboard server restarted" \
  || echo "⚠ Dashboard server restart failed (non-fatal)"

# --- 3. Restart bot via launchd ---
if [ -f "$PLIST" ]; then
  # Worktree-aware sync: launchd points at a fixed path (the main repo's dist).
  # If we're running from a different directory (a worktree), the local build
  # landed in $PROJECT_DIR/dist but launchd will start the OLD code from the
  # main repo path. Detect and sync before restart.
  LAUNCHD_DIR="$(grep -A1 'WorkingDirectory' "$PLIST" | tail -1 | sed -E 's|.*<string>(.*)</string>.*|\1|')"
  if [ -n "$LAUNCHD_DIR" ] && [ "$LAUNCHD_DIR" != "$PROJECT_DIR" ]; then
    echo "Worktree detected. Syncing dist to launchd target: $LAUNCHD_DIR"
    if [ ! -d "$LAUNCHD_DIR" ]; then
      echo "✗ Launchd target dir does not exist: $LAUNCHD_DIR"
      exit 1
    fi
    rsync -a --delete "$PROJECT_DIR/dist/" "$LAUNCHD_DIR/dist/" \
      && echo "✓ Dist synced to launchd target" \
      || { echo "✗ Dist sync failed"; exit 1; }
  fi

  # Kill any stale Telegram MCP plugin processes holding the bot token.
  # When a Claude Code session ends abnormally, bun server.ts keeps running
  # as a zombie and causes 409 conflicts on the next bot startup.
  BOT_PID_FILE="$HOME/.claude/channels/telegram/bot.pid"
  if [ -f "$BOT_PID_FILE" ]; then
    BOT_PID=$(cat "$BOT_PID_FILE" 2>/dev/null)
    if [ -n "$BOT_PID" ] && kill -0 "$BOT_PID" 2>/dev/null; then
      kill "$BOT_PID" 2>/dev/null && echo "✓ Killed stale Telegram MCP process ($BOT_PID)" || true
    fi
  fi
  # Belt-and-suspenders: kill any bun server.ts that may have slipped through
  pkill -f "bun.*server\.ts" 2>/dev/null && echo "✓ Killed orphaned bun server.ts" || true

  launchctl unload "$PLIST" 2>/dev/null || true
  sleep 5
  launchctl load "$PLIST"
  echo "✓ Bot service restarted"
  sleep 2
  tail -10 /tmp/claudepaw.log
else
  echo "No launchd service found. Run manually: npm run start"
fi

echo ""
echo "✓ Full deploy complete"
