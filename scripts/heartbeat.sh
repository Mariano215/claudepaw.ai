#!/bin/bash
# heartbeat.sh -- poll /api/v1/health; trip kill switch after FAIL_THRESHOLD consecutive failures
set -u

DASHBOARD_URL="${DASHBOARD_URL:-http://127.0.0.1:3000/api/v1/health}"
KILL_URL="${KILL_URL:-http://127.0.0.1:3000/api/v1/system-state/kill-switch}"
TOKEN="${ADMIN_API_TOKEN:-${DASHBOARD_API_TOKEN:-}}"
FAIL_STATE_FILE="${FAIL_STATE_FILE:-$HOME/.claudepaw/heartbeat-fails}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"

mkdir -p "$(dirname "$FAIL_STATE_FILE")"

if curl -sf -m 10 "$DASHBOARD_URL" > /dev/null 2>&1; then
  : > "$FAIL_STATE_FILE"
  exit 0
fi

# Health check failed -- increment counter
fails=0
if [[ -f "$FAIL_STATE_FILE" ]]; then
  fails=$(cat "$FAIL_STATE_FILE" 2>/dev/null || echo 0)
  # strip whitespace / non-numeric
  fails=$(echo "$fails" | tr -cd '0-9')
  [[ -z "$fails" ]] && fails=0
fi

fails=$(( fails + 1 ))
echo "$fails" > "$FAIL_STATE_FILE"

if (( fails >= FAIL_THRESHOLD )); then
  curl -sf -m 10 -X POST "$KILL_URL" \
    -H 'Content-Type: application/json' \
    -H "x-dashboard-token: $TOKEN" \
    -d '{"reason":"heartbeat: dashboard /health unreachable for 15+ min"}' > /dev/null 2>&1 || true
  logger -t claudepaw-heartbeat "kill switch tripped after $fails consecutive failures"
fi

exit 0
