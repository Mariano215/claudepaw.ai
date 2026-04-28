#!/bin/bash
# Deploy dashboard files to Hostinger (no bot restart)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DASHBOARD_HOST="${DASHBOARD_HOST:-root@localhost}"
DASHBOARD_DIR="${DASHBOARD_DIR:-/opt/claudepaw-server}"

cd "$PROJECT_DIR"

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

if [ -z "${DASHBOARD_API_TOKEN:-}" ]; then
  echo "ABORT: local .env is missing DASHBOARD_API_TOKEN"
  exit 1
fi

if ! ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" "test -s '$DASHBOARD_DIR/.env' && grep -Eq '^DASHBOARD_API_TOKEN=.+$' '$DASHBOARD_DIR/.env'"; then
  echo "ABORT: remote $DASHBOARD_DIR/.env is missing DASHBOARD_API_TOKEN"
  exit 1
fi

echo "Deploying dashboard to Hostinger..."

rsync -az --delete \
  server/public/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/public/"
echo "✓ public/"

rsync -az --delete \
  server/src/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/src/"
echo "✓ src/"

rsync -az --delete \
  server/themes/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/themes/"
echo "✓ themes/"

# Canonical projects manifest -- read on server boot by seedCanonicalProjects()
# in server/src/db.ts. Source of truth for which projects exist in the bot DB
# on Hostinger; idempotent INSERT OR IGNORE so runtime mutations survive.
rsync -az --delete \
  server/seeds/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/seeds/"
echo "✓ seeds/"

rsync -az --delete \
  server/integrations/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/integrations/"
echo "✓ integrations/"

rsync -az \
  server/package.json server/tsconfig.json \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/"
echo "✓ config files"

# Sync pm2 ecosystem file (fork mode is pinned here -- see CLAUDE.md)
rsync -az \
  ecosystem.config.cjs \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/"
echo "✓ ecosystem.config.cjs"

# Copy scripts if they exist
if [ -d "server/scripts" ]; then
  rsync -az --delete \
    server/scripts/ \
    "$DASHBOARD_HOST:$DASHBOARD_DIR/scripts/"
  echo "✓ scripts/"
fi

# Sync agent definitions (base + templates + projects)
rsync -az --delete \
  agents/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/agents/"
echo "✓ agents/"

rsync -az --delete \
  templates/ \
  "$DASHBOARD_HOST:$DASHBOARD_DIR/templates/"
echo "✓ templates/"

if [ -d "projects" ]; then
  rsync -az \
    projects/ \
    "$DASHBOARD_HOST:$DASHBOARD_DIR/projects/"
  echo "✓ projects/"
fi

# Rebuild + restart on server
# IMPORTANT: Must use PM2 in fork mode (not cluster) -- cluster mode breaks WebSocket upgrades.
# Fork mode is pinned in ecosystem.config.cjs at repo root; we sync it above and invoke
# `pm2 startOrRestart ecosystem.config.cjs` so the flags never drift out of version control.
ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" \
  "cd $DASHBOARD_DIR && npm install 2>/dev/null && npx tsc 2>/dev/null && fuser -k 3000/tcp 2>/dev/null; sleep 1; pm2 startOrRestart ecosystem.config.cjs 2>/dev/null; pm2 save 2>/dev/null"
echo "✓ Server rebuilt and restarted"

echo ""
echo "✓ Dashboard deploy complete"
