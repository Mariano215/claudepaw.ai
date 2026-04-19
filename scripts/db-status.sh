#!/bin/bash
# Show local and production DB status so it is obvious which side owns the
# newest operational state before any manual DB action.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DASHBOARD_HOST="${DASHBOARD_HOST:-root@localhost}"
DASHBOARD_DIR="${DASHBOARD_DIR:-/opt/claudepaw-server}"
STORE_DIR="$PROJECT_DIR/store"

echo "ClaudePaw DB status"
echo "Local store:  $STORE_DIR"
echo "Remote store: $DASHBOARD_HOST:$DASHBOARD_DIR/store"
echo ""

for db in claudepaw.db telemetry.db; do
  echo "$db"
  if [ -f "$STORE_DIR/$db" ]; then
    stat -f "  local:  %Sm  %z bytes" -t "%Y-%m-%d %H:%M:%S" "$STORE_DIR/$db"
  else
    echo "  local:  missing"
  fi

  remote_line="$(ssh -o ConnectTimeout=10 "$DASHBOARD_HOST" "if [ -f '$DASHBOARD_DIR/store/$db' ]; then stat -f '%Sm  %z bytes' -t '%Y-%m-%d %H:%M:%S' '$DASHBOARD_DIR/store/$db'; else echo missing; fi" 2>/dev/null || true)"
  if [ -n "$remote_line" ]; then
    echo "  remote: $remote_line"
  else
    echo "  remote: unavailable"
  fi
  echo ""
done
