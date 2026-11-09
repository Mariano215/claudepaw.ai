#!/bin/bash
# Usage: ./scripts/notify.sh "Your message here"
# Reads TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID from .env

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Source .env
if [ -f "$PROJECT_DIR/.env" ]; then
  export $(grep -v '^#' "$PROJECT_DIR/.env" | xargs)
fi

if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$ALLOWED_CHAT_ID" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID must be set in .env"
  exit 1
fi

MESSAGE="${1:-No message provided}"

curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="${ALLOWED_CHAT_ID}" \
  -d text="${MESSAGE}" > /dev/null

echo "✓ Sent: ${MESSAGE:0:50}..."
