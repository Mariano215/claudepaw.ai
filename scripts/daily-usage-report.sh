#!/bin/bash
# scripts/daily-usage-report.sh
#
# Wrapper invoked by launchd (com.claudepaw.daily-report.plist) to run the
# daily ClaudePaw usage + API report. Writes HTML preview to /tmp and sends
# the email via Gmail OAuth.
#
# Config: set DAILY_REPORT_ENABLED / DAILY_REPORT_PERIOD_HOURS / DAILY_REPORT_TO
# in the ClaudePaw .env file. To temporarily disable without editing .env,
# touch /tmp/claudepaw-daily-report.disabled.

set -euo pipefail

PROJECT_DIR="$HOME/claudepaw"
NODE_BIN="/opt/homebrew/bin/node"
LOG_FILE="/tmp/claudepaw-daily-report.log"

if [ -f "/tmp/claudepaw-daily-report.disabled" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Disabled via /tmp flag, skipping." >> "$LOG_FILE"
  exit 0
fi

cd "$PROJECT_DIR"

{
  echo "----"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Running daily report"
  "$NODE_BIN" dist/reports/daily-usage-report.js 2>&1
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] exit=$?"
} >> "$LOG_FILE"
