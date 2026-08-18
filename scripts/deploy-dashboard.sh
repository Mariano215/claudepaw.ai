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

# package-lock.json ships too: without it the remote `npm install` resolves
# transitive deps against its own stale tree, so security fixes verified here
# never reach production. Keep the lock and package.json together.
rsync -az \
  server/package.json server/package-lock.json server/tsconfig.json \
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
# `pm2 start ecosystem.config.cjs` so the flags never drift out of version control.
# Clean slate every deploy: delete from PM2, free port 3000 in a verify loop
# (kills any orphan that would otherwise leave PM2 stuck in EADDRINUSE), then
# start one fresh fork-mode process.
# Build FIRST and fail the deploy on any compile error. The old version piped
# tsc errors to /dev/null and restarted regardless, which shipped a broken
# dist and took the dashboard down for 3 days (Jun 8-11 2026). Never silence
# the remote build.
if ! ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" \
  "cd $DASHBOARD_DIR && npm install --no-audit --no-fund >/dev/null && npx tsc"; then
  echo "ABORT: remote TypeScript build FAILED -- server NOT restarted (old process left running)"
  exit 1
fi
echo "✓ remote build OK"

ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" \
  "cd $DASHBOARD_DIR && pm2 delete claudepaw-server 2>/dev/null; \
   for i in 1 2 3 4 5; do kill -9 \$(lsof -ti:3000) 2>/dev/null; sleep 1; lsof -ti:3000 >/dev/null 2>&1 || break; done; \
   pm2 start ecosystem.config.cjs 2>/dev/null; pm2 save 2>/dev/null"

# Verify the server actually came up and is listening. PM2 'online' is not
# proof of life (a module-load crash can leave a zombie): require an HTTP 200.
sleep 4
if ! ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" \
  "curl -s -o /dev/null -w '%{http_code}' -m 8 http://127.0.0.1:3000/api/v1/system-state/kill-switch -H \"x-dashboard-token: \$(grep '^DASHBOARD_API_TOKEN=' $DASHBOARD_DIR/.env | cut -d= -f2)\" | grep -q 200"; then
  echo "ABORT: server restarted but kill-switch endpoint is NOT answering -- check pm2 logs claudepaw-server"
  exit 1
fi
echo "✓ Server rebuilt, restarted, and answering"

echo ""
echo "✓ Dashboard deploy complete"
