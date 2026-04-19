#!/bin/bash
set -e

LOG_FILE="./store/upgrade.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting upgrade..." >> "$LOG_FILE"

cd .

git pull origin main >> "$LOG_FILE" 2>&1

# ensure DB files stay mode 600 (ClaudePaw review 2026-04-17 C1)
chmod 600 store/*.db 2>/dev/null || true

npm run build >> "$LOG_FILE" 2>&1

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restarting bot..." >> "$LOG_FILE"

launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.claudepaw.app.plist 2>/dev/null || true

sleep 2

launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.claudepaw.app.plist

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Upgrade complete." >> "$LOG_FILE"
