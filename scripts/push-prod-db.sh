#!/bin/bash
# Push selected local databases to production. This is intentionally separate
# from the normal deploy path because it overwrites remote operational state.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DASHBOARD_HOST="${DASHBOARD_HOST:-root@localhost}"
DASHBOARD_DIR="${DASHBOARD_DIR:-/opt/claudepaw-server}"
STORE_DIR="$PROJECT_DIR/store"
DBS_TO_PUSH="${DBS_TO_PUSH:-claudepaw.db}"

if [ "${FORCE_PUSH_PROD_DB:-}" != "1" ]; then
  echo "Refusing to push DBs without FORCE_PUSH_PROD_DB=1"
  echo "This operation overwrites remote settings, action items, and other production state."
  exit 1
fi

echo "Pushing local DB snapshots to $DASHBOARD_HOST..."
echo "Databases: $DBS_TO_PUSH"
ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" "mkdir -p $DASHBOARD_DIR/store"

for db in $DBS_TO_PUSH; do
  if [ ! -f "$STORE_DIR/$db" ]; then
    echo "  - skipping $db (not found locally)"
    continue
  fi
  SNAPSHOT="$(mktemp -t ${db%.db}-push-XXXXXX.db)"
  if sqlite3 "$STORE_DIR/$db" ".backup $SNAPSHOT" 2>/dev/null \
    && sqlite3 "$SNAPSHOT" "PRAGMA integrity_check;" 2>/dev/null | head -n1 | grep -q '^ok$'; then
    ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" \
      "rm -f $DASHBOARD_DIR/store/$db-wal $DASHBOARD_DIR/store/$db-shm" 2>/dev/null || true
    rsync -az "$SNAPSHOT" "$DASHBOARD_HOST:$DASHBOARD_DIR/store/$db"
    echo "  ✓ $db"
  else
    echo "  ⚠ local snapshot failed for $db"
  fi
  rm -f "$SNAPSHOT"
done

echo "Production DB push complete."
