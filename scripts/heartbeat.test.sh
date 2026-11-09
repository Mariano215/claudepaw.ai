#!/bin/bash
# heartbeat.test.sh -- integration tests for heartbeat.sh
set -e
cd "$(dirname "$0")"

PASS=0
FAIL=0

_pass() { echo "PASS: $1"; PASS=$(( PASS + 1 )); }
_fail() { echo "FAIL: $1"; FAIL=$(( FAIL + 1 )); }

cleanup() {
  kill "$PYPID" 2>/dev/null || true
  wait "$PYPID" 2>/dev/null || true
}

# -------------------------------------------------------------------------
# Healthy path: 200 response -> state file empty, exit 0
# -------------------------------------------------------------------------

export DASHBOARD_URL="http://127.0.0.1:9999/health-ok"
export KILL_URL="http://127.0.0.1:9999/kill-switch"
export FAIL_STATE_FILE="$(mktemp)"
export FAIL_THRESHOLD=3
export ADMIN_API_TOKEN="test-token"

# Python stub: GET -> 200, POST -> 200
# Side channel: write POST body to a temp file so we can assert kill-switch trips
KILL_LOG="$(mktemp)"

python3 - "$KILL_LOG" <<'PYEOF' &
import http.server, socketserver, sys, os

kill_log = sys.argv[1]

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b''
        with open(kill_log, 'ab') as f:
            f.write(body + b'\n')
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')
    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', 9999), H) as srv:
    srv.serve_forever()
PYEOF

PYPID=$!
trap cleanup EXIT
sleep 0.5

bash heartbeat.sh
if [[ -s "$FAIL_STATE_FILE" ]]; then
  _fail "state file should be empty after healthy check (got: $(cat "$FAIL_STATE_FILE"))"
else
  _pass "healthy check clears state file"
fi

# -------------------------------------------------------------------------
# Unhealthy path: no server listening -> failure counts increment
# -------------------------------------------------------------------------

kill "$PYPID" 2>/dev/null || true
wait "$PYPID" 2>/dev/null || true
trap - EXIT

export DASHBOARD_URL="http://127.0.0.1:9998/health-down"
export KILL_URL="http://127.0.0.1:9998/kill-switch"
export FAIL_STATE_FILE="$(mktemp)"
export FAIL_THRESHOLD=3
unset ADMIN_API_TOKEN

bash heartbeat.sh || true
count=$(cat "$FAIL_STATE_FILE")
if [[ "$count" == "1" ]]; then
  _pass "first failure increments count to 1"
else
  _fail "expected 1 failure, got '$count'"
fi

bash heartbeat.sh || true
bash heartbeat.sh || true
count=$(cat "$FAIL_STATE_FILE")
if [[ "$count" == "3" ]]; then
  _pass "third failure reaches threshold (count=3)"
else
  _fail "expected 3 failures, got '$count'"
fi

# -------------------------------------------------------------------------
# Kill-switch trip: threshold hit with a live stub -> POST received
# -------------------------------------------------------------------------

KILL_LOG2="$(mktemp)"

python3 - "$KILL_LOG2" <<'PYEOF' &
import http.server, socketserver, sys

kill_log = sys.argv[1]

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # /health-down returns 503 to simulate outage
        if self.path == '/api/v1/health':
            self.send_response(503)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b''
        with open(kill_log, 'ab') as f:
            f.write(body + b'\n')
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')
    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', 9997), H) as srv:
    srv.serve_forever()
PYEOF

PY2PID=$!
trap 'kill $PY2PID 2>/dev/null; wait $PY2PID 2>/dev/null || true' EXIT
sleep 0.5

export DASHBOARD_URL="http://127.0.0.1:9997/api/v1/health"
export KILL_URL="http://127.0.0.1:9997/api/v1/system-state/kill-switch"
export FAIL_STATE_FILE="$(mktemp)"
export FAIL_THRESHOLD=3
export ADMIN_API_TOKEN="test-token"

# Pre-seed state file at threshold - 1 so next run trips it
echo "2" > "$FAIL_STATE_FILE"

bash heartbeat.sh || true

if [[ -s "$KILL_LOG2" ]]; then
  _pass "kill-switch POST sent when threshold reached"
else
  _fail "kill-switch POST not received after threshold"
fi

kill "$PY2PID" 2>/dev/null || true
wait "$PY2PID" 2>/dev/null || true
trap - EXIT

# -------------------------------------------------------------------------
# Summary
# -------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
echo "PASS: heartbeat.sh behaves correctly"
