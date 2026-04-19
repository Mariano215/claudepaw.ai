#!/bin/bash
# Pull production database snapshots into a local archive directory.
# This script never overwrites the live local store/ DBs used by development.
# Use the archived copies for inspection, diffing, or manual recovery only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DASHBOARD_HOST="${DASHBOARD_HOST:-root@localhost}"
DASHBOARD_DIR="${DASHBOARD_DIR:-/opt/claudepaw-server}"
STORE_DIR="$PROJECT_DIR/store"
SNAPSHOT_STAMP="$(date '+%Y%m%d-%H%M%S')"
SNAPSHOT_DIR="$STORE_DIR/prod-snapshots/$SNAPSHOT_STAMP"

mkdir -p "$STORE_DIR"
mkdir -p "$SNAPSHOT_DIR"

snapshot_remote_db() {
  local db="$1"
  local remote_tmp="/tmp/$db.pull"
  local integrity

  echo "  snapshotting $db on remote..."
  if ! ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" \
    "sqlite3 $DASHBOARD_DIR/store/$db \".timeout 5000\" \".backup $remote_tmp\"" 2>/dev/null; then
    echo "  ✗ failed to snapshot $db"
    return 1
  fi

  integrity="$(ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" \
    "sqlite3 $remote_tmp \"PRAGMA integrity_check;\" | head -n1" 2>/dev/null || true)"
  if [ "${integrity:-}" != "ok" ] && [ -n "${integrity:-}" ]; then
    echo "  ⚠ remote $db integrity warning: $integrity"
  fi

  return 0
}

echo "Pulling production DB snapshots from $DASHBOARD_HOST into $SNAPSHOT_DIR..."
ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" "mkdir -p $DASHBOARD_DIR/store"

pull_failed=0

for db in claudepaw.db telemetry.db; do
  SNAPSHOT="$SNAPSHOT_DIR/$db"
  if snapshot_remote_db "$db"; then
    rsync -az "$DASHBOARD_HOST:/tmp/$db.pull" "$SNAPSHOT"
    ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" "rm -f /tmp/$db.pull"
    echo "  ✓ $db -> $SNAPSHOT"
  else
    rm -f "$SNAPSHOT"
    echo "  ✗ failed to snapshot $db"
    pull_failed=1
    break
  fi
done

if [ "$pull_failed" -ne 0 ]; then
  echo "Production DB pull aborted."
  echo "A remote database snapshot failed or failed integrity checks."
  exit 1
fi

echo "Production DB snapshot complete."
echo "Archived snapshots are stored in $SNAPSHOT_DIR"
echo "Live local DBs in $STORE_DIR were not modified."
