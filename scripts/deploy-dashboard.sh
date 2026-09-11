#!/bin/bash
# Deploy dashboard files to Hostinger (no bot restart)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DASHBOARD_HOST="${DASHBOARD_HOST:-root@localhost}"
DASHBOARD_DIR="${DASHBOARD_DIR:-/opt/claudepaw-server}"
SSH_OPTS=(
  -n
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ConnectionAttempts=1
  -o ServerAliveInterval=2
  -o ServerAliveCountMax=2
)
RSYNC_SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o ServerAliveInterval=2 -o ServerAliveCountMax=2"

dashboard_rsync() {
  rsync -e "$RSYNC_SSH" "$@" </dev/null
}

cd "$PROJECT_DIR"

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091 # Project-local environment is resolved dynamically.
  source "$PROJECT_DIR/.env"
  set +a
fi

if [ -z "${DASHBOARD_API_TOKEN:-}" ]; then
  echo "ABORT: local .env is missing DASHBOARD_API_TOKEN"
  exit 1
fi

# Keep transport failure distinct from a reachable host with bad config.
set +e
# shellcheck disable=SC2029 # Host/path constants intentionally form the remote command.
ssh "${SSH_OPTS[@]}" "$DASHBOARD_HOST" "test -s '$DASHBOARD_DIR/.env' && grep -Eq '^DASHBOARD_API_TOKEN=.+$' '$DASHBOARD_DIR/.env'"
REMOTE_ENV_STATUS=$?
set -e
if [ "$REMOTE_ENV_STATUS" -eq 255 ]; then
  echo "ABORT: cannot connect to dashboard host $DASHBOARD_HOST"
  exit 1
elif [ "$REMOTE_ENV_STATUS" -ne 0 ]; then
  echo "ABORT: connected, but remote $DASHBOARD_DIR/.env is missing DASHBOARD_API_TOKEN"
  exit 1
fi

echo "Deploying dashboard to Hostinger..."

# Refresh the generated trader-schema copy so the server build never imports
# across the repo boundary (../../src does not exist on Hostinger -- caused
# the Jun 8 2026 boot crash). Single source of truth stays src/trader/schema.ts.
{
  echo "// GENERATED FILE -- do not edit."
  echo "// Source of truth: src/trader/schema.ts (repo root)."
  echo "// Refreshed by scripts/deploy-dashboard.sh on every deploy so the server"
  echo "// build never imports across the repo boundary (rootDir=src; /opt has no ../../src)."
  cat src/trader/schema.ts
} > server/src/trader-schema.gen.ts
echo "✓ trader-schema.gen.ts refreshed"

dashboard_rsync -az --delete \
  server/public/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/public/"
echo "✓ public/"

dashboard_rsync -az --delete \
  server/src/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/src/"
echo "✓ src/"

dashboard_rsync -az --delete \
  server/themes/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/themes/"
echo "✓ themes/"

# Canonical projects manifest -- read on server boot by seedCanonicalProjects()
# in server/src/db.ts. Source of truth for which projects exist in the bot DB
# on Hostinger; idempotent INSERT OR IGNORE so runtime mutations survive.
dashboard_rsync -az --delete \
  server/seeds/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/seeds/"
echo "✓ seeds/"

dashboard_rsync -az --delete \
  server/integrations/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/integrations/"
echo "✓ integrations/"

# package-lock.json ships too: without it the remote `npm install` resolves
# transitive deps against its own stale tree, so security fixes verified here
# never reach production. Keep the lock and package.json together.
dashboard_rsync -az \
  server/package.json server/package-lock.json server/tsconfig.json \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/"
echo "✓ config files"

# Sync pm2 ecosystem file (fork mode is pinned here -- see CLAUDE.md)
dashboard_rsync -az \
  ecosystem.config.cjs \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/"
echo "✓ ecosystem.config.cjs"

# Copy scripts if they exist
if [ -d "server/scripts" ]; then
  dashboard_rsync -az --delete \
    server/scripts/ \
    "$DASHBOARD_HOST:$DASHBOARD_DIR/scripts/"
  echo "✓ scripts/"
fi

# Sync agent definitions (base + templates + projects)
dashboard_rsync -az --delete \
  agents/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/agents/"
echo "✓ agents/"

dashboard_rsync -az --delete \
  templates/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/templates/"
echo "✓ templates/"

if [ -d "projects" ]; then
  dashboard_rsync -az \
    projects/ \
    "$DASHBOARD_HOST:$DASHBOARD_DIR/projects/"
  echo "✓ projects/"
fi

# Rebuild + restart on server
# IMPORTANT: Must use PM2 in fork mode (not cluster) -- cluster mode breaks WebSocket upgrades.
# Fork mode is pinned in ecosystem.config.cjs at repo root; we sync it above and invoke
# `pm2 start ecosystem.config.cjs` so the flags never drift out of version control.
# Clean slate every deploy: a detached remote job deletes PM2, frees port 3000,
# and starts one fresh fork-mode process. Detaching is critical: an SSH reset
# after `pm2 delete` must not terminate the remaining restart commands.
# Build FIRST and fail the deploy on any compile error. The old version piped
# tsc errors to /dev/null and restarted regardless, which shipped a broken
# dist and took the dashboard down for 3 days (Jun 8-11 2026). Never silence
# the remote build.
# shellcheck disable=SC2029 # Host/path constants intentionally form the remote command.
if ! ssh "${SSH_OPTS[@]}" "$DASHBOARD_HOST" \
  "cd $DASHBOARD_DIR && npm install --no-audit --no-fund >/dev/null && npx tsc"; then
  echo "ABORT: remote TypeScript build FAILED -- server NOT restarted (old process left running)"
  exit 1
fi
echo "✓ remote build OK"

bash "$SCRIPT_DIR/queue-dashboard-restart.sh" "$DASHBOARD_HOST" "$DASHBOARD_DIR"

echo ""
echo "✓ Dashboard deploy complete"
