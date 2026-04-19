#!/bin/bash
# Full deploy: typecheck, test, build, commit, push, deploy dashboard, restart bot.
# IMPORTANT: This script deliberately does NOT copy production SQLite files into
# the live local store. Production and local development each keep their own
# databases, and shared operational state must sync logically over APIs.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST="$HOME/Library/LaunchAgents/com.claudepaw.app.plist"
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

echo "=== ClaudePaw Full Deploy ==="
echo ""

# --- 1. Typecheck ---
echo "[1/7] Typechecking..."
npx tsc --noEmit || { echo "ABORT: typecheck failed"; exit 1; }
echo "  ✓ typecheck passed"

# --- 2. Tests ---
echo "[2/7] Running tests..."
npx vitest run || { echo "ABORT: tests failed"; exit 1; }
echo "  ✓ tests passed"

echo "[2.5/7] Dashboard auth readiness..."
echo "  ✓ local and remote DASHBOARD_API_TOKEN present"

# --- 3. Build ---
echo "[3/7] Building..."
npx tsc || { echo "ABORT: build failed"; exit 1; }
echo "  ✓ build OK"

# --- 4. Git commit (if there are changes) ---
echo "[4/7] Committing..."
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "deploy: $(date '+%Y-%m-%d %H:%M')" || true
  echo "  ✓ committed"
else
  echo "  - nothing to commit"
fi

# --- 5. Git push ---
echo "[5/7] Pushing to GitHub..."
git push origin main 2>/dev/null \
  && echo "  ✓ pushed" \
  || echo "  ⚠ push failed (non-fatal, will retry next deploy)"

# --- 6. Deploy dashboard to Hostinger ---
echo "[6/7] Deploying dashboard..."
rsync -az --delete server/public/ "$DASHBOARD_HOST:$DASHBOARD_DIR/public/" 2>/dev/null \
  && echo "  ✓ public/" \
  || echo "  ⚠ public/ failed"

rsync -az --delete server/src/ "$DASHBOARD_HOST:$DASHBOARD_DIR/src/" 2>/dev/null \
  && echo "  ✓ src/" \
  || echo "  ⚠ src/ failed"

rsync -az --delete server/integrations/ "$DASHBOARD_HOST:$DASHBOARD_DIR/integrations/" 2>/dev/null \
  && echo "  ✓ integrations/" \
  || echo "  ⚠ integrations/ failed"

rsync -az server/package.json server/tsconfig.json "$DASHBOARD_HOST:$DASHBOARD_DIR/" 2>/dev/null \
  && echo "  ✓ config" \
  || echo "  ⚠ config failed"

rsync -az ecosystem.config.cjs "$DASHBOARD_HOST:$DASHBOARD_DIR/" 2>/dev/null \
  && echo "  ✓ ecosystem.config.cjs" \
  || echo "  ⚠ ecosystem.config.cjs failed"

if [ -d "server/scripts" ]; then
  rsync -az --delete server/scripts/ "$DASHBOARD_HOST:$DASHBOARD_DIR/scripts/" 2>/dev/null \
    && echo "  ✓ scripts/" \
    || echo "  ⚠ scripts/ failed"
fi

echo "  - skipping DB sync (remote production state is authoritative)"

ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" \
  "cd $DASHBOARD_DIR && npm install 2>/dev/null && npx tsc 2>/dev/null && fuser -k 3000/tcp 2>/dev/null; sleep 1; pm2 startOrRestart ecosystem.config.cjs 2>/dev/null; pm2 save 2>/dev/null" 2>/dev/null \
  && echo "  ✓ server restarted" \
  || echo "  ⚠ server restart failed"

# --- 7. Restart bot ---
echo "[7/7] Restarting bot..."
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  sleep 5
  launchctl load "$PLIST"
  echo "  ✓ bot restarted"
  sleep 2
  echo ""
  echo "=== Recent logs ==="
  tail -5 /tmp/claudepaw.log
else
  echo "  No launchd service. Run manually: npm run start"
fi

echo ""
echo "=== Deploy complete ==="
echo "Note: production DBs were left in place. Use scripts/pull-prod-db.sh for archived snapshots."
