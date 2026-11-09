#!/bin/bash
# Runs on the dashboard host. This process is launched under nohup so an SSH
# disconnect cannot strand PM2 between delete and start.
set -euo pipefail

DASHBOARD_DIR="${1:-/opt/claudepaw-server}"
DEPLOY_ID="${2:?deploy id is required}"
if [[ ! "$DASHBOARD_DIR" =~ ^/[A-Za-z0-9._/-]+$ || ! "$DEPLOY_ID" =~ ^[0-9]+-[0-9]+$ ]]; then
  echo "invalid restart arguments" >&2
  exit 2
fi
READY_FILE="/tmp/claudepaw-dashboard-${DEPLOY_ID}.ready"

cd "$DASHBOARD_DIR"

pm2 delete claudepaw-server >/dev/null 2>&1 || true
for _attempt in 1 2 3 4 5; do
  PORT_PIDS="$(lsof -ti:3000 2>/dev/null || true)"
  if [ -z "$PORT_PIDS" ]; then
    break
  fi
  read -r -a PORT_PID_ARRAY <<< "$PORT_PIDS"
  kill -9 "${PORT_PID_ARRAY[@]}" 2>/dev/null || true
  sleep 1
done

if lsof -ti:3000 >/dev/null 2>&1; then
  echo "port 3000 is still occupied after cleanup" >&2
  exit 1
fi

pm2 start ecosystem.config.cjs >/dev/null
pm2 save >/dev/null
printf '%s\n' "$DEPLOY_ID" > "$READY_FILE"
