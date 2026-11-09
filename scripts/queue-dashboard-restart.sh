#!/bin/bash
# Queue a disconnect-safe dashboard restart, then prove that this exact deploy
# completed and the authenticated server is answering.
set -euo pipefail

DASHBOARD_HOST="${1:?dashboard host is required}"
DASHBOARD_DIR="${2:?dashboard directory is required}"
if [[ ! "$DASHBOARD_HOST" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$ ]]; then
  echo "invalid dashboard host" >&2
  exit 2
fi
if [[ ! "$DASHBOARD_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "invalid dashboard directory" >&2
  exit 2
fi
DEPLOY_ID="$(date +%s)-$$"
REMOTE_SCRIPT="/tmp/claudepaw-dashboard-restart-${DEPLOY_ID}.sh"
REMOTE_LOG="/tmp/claudepaw-dashboard-restart-${DEPLOY_ID}.log"
READY_FILE="/tmp/claudepaw-dashboard-${DEPLOY_ID}.ready"
SSH_OPTS=(
  -n
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ConnectionAttempts=1
  -o ServerAliveInterval=2
  -o ServerAliveCountMax=2
)

rsync -az \
  -e "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o ServerAliveInterval=2 -o ServerAliveCountMax=2" \
  "$(dirname "$0")/remote-dashboard-restart.sh" "$DASHBOARD_HOST:$REMOTE_SCRIPT" </dev/null

# Keep SSH away from terminal stdin and fork the restart into its own remote
# session. Keepalives surface a reset automatically instead of waiting for the
# operator to press Enter and write to a stale TCP connection.
# shellcheck disable=SC2029 # Restricted args are intentionally expanded into the remote command.
if ! ssh "${SSH_OPTS[@]}" "$DASHBOARD_HOST" \
  "chmod 700 '$REMOTE_SCRIPT' && setsid -f /bin/bash '$REMOTE_SCRIPT' '$DASHBOARD_DIR' '$DEPLOY_ID' >'$REMOTE_LOG' 2>&1 </dev/null"; then
  echo "Queue connection dropped; checking the unique completion marker before deciding whether launch failed."
fi

for attempt in 1 2 3 4 5 6 7 8; do
  sleep 3
  # shellcheck disable=SC2029 # Paths/ID pass the allowlist above; command substitutions stay remote.
  if ssh "${SSH_OPTS[@]}" "$DASHBOARD_HOST" \
    "test \"\$(cat '$READY_FILE' 2>/dev/null)\" = '$DEPLOY_ID' && curl -s -o /dev/null -w '%{http_code}' -m 8 http://127.0.0.1:3000/api/v1/system-state/kill-switch -H \"x-dashboard-token: \$(grep '^DASHBOARD_API_TOKEN=' '$DASHBOARD_DIR/.env' | cut -d= -f2)\" | grep -q 200"; then
    # shellcheck disable=SC2029 # Restricted generated paths are intentionally expanded remotely.
    ssh "${SSH_OPTS[@]}" "$DASHBOARD_HOST" "rm -f '$REMOTE_SCRIPT' '$READY_FILE'" >/dev/null 2>&1 || true
    echo "✓ Server rebuilt, restarted, and answering (deploy $DEPLOY_ID)"
    exit 0
  fi
  echo "Waiting for dashboard restart ($attempt/8)..."
done

echo "ABORT: dashboard restart did not verify. Remote log: $REMOTE_LOG" >&2
# shellcheck disable=SC2029 # Restricted generated path is intentionally expanded remotely.
ssh "${SSH_OPTS[@]}" "$DASHBOARD_HOST" "tail -40 '$REMOTE_LOG' 2>/dev/null || true" >&2 || true
exit 1
