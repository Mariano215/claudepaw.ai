#!/bin/bash
# Additive, one-way sync of trader history tables from the local bot DB to the
# Hostinger server DB. Fixes dashboard drift when signals/decisions generated
# locally have not reached the server copy.
#
# WHY THIS EXISTS (and why `npm run deploy` does NOT do it):
#   deploy.sh rsyncs server code + seeds and restarts PM2 -- it never copies bot
#   DB rows. push-prod-db.sh does a FULL claudepaw.db overwrite, which would
#   clobber server-owned state (trader_approvals are created on the dashboard and
#   are AHEAD on the server). This script is the safe middle ground: it only
#   INSERTs rows missing on the server, keyed by primary key, and never touches
#   any table not listed below.
#
# Tables synced (local -> server, INSERT OR IGNORE): trader_strategies,
# trader_signals, trader_decisions. trader_approvals is deliberately excluded.
#
# Usage:
#   bash scripts/sync-trader-db.sh --dry-run   # show rows that would be added
#   bash scripts/sync-trader-db.sh             # apply
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DASHBOARD_HOST="${DASHBOARD_HOST:-root@localhost}"
REMOTE_DB="${REMOTE_DB:-/opt/claudepaw-server/store/claudepaw.db}"
LOCAL_DB="${LOCAL_DB:-$PROJECT_DIR/store/claudepaw.db}"
SQLITE="${SQLITE:-$(command -v sqlite3 || echo /usr/bin/sqlite3)}"
REMOTE_SNAP="/tmp/trader-sync-snap.db"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# Explicit column lists (NOT SELECT *) -- local and server schemas have drifted
# (e.g. engine_order_id was ALTER-added locally), so positional copies are unsafe.
SIG_COLS="id, strategy_id, asset, side, raw_score, horizon_days, enrichment_json, generated_at, status"
DEC_COLS="id, signal_id, action, asset, size_usd, entry_type, entry_price, stop_loss, take_profit, thesis, confidence, committee_transcript_id, decided_at, status, engine_order_id"
STR_COLS="id, name, asset_class, tier, status, params_json, created_at, updated_at, max_size_usd"

[ -f "$LOCAL_DB" ] || { echo "local DB not found: $LOCAL_DB"; exit 1; }

echo "Snapshotting local DB..."
LOCAL_SNAP="$(mktemp -t trader-sync-XXXXXX.db)"
trap 'rm -f "$LOCAL_SNAP"' EXIT
"$SQLITE" "$LOCAL_DB" ".backup $LOCAL_SNAP"
"$SQLITE" "$LOCAL_SNAP" "PRAGMA integrity_check;" | head -1 | grep -q '^ok$' \
  || { echo "snapshot integrity check failed"; exit 1; }

echo "Copying snapshot to $DASHBOARD_HOST..."
rsync -az "$LOCAL_SNAP" "$DASHBOARD_HOST:$REMOTE_SNAP"

if [ "$DRY_RUN" = "1" ]; then
  echo "=== DRY RUN: rows that would be added (server is missing these ids) ==="
  ssh -o ConnectTimeout=15 "$DASHBOARD_HOST" "sqlite3 '$REMOTE_DB' \"
    ATTACH '$REMOTE_SNAP' AS src;
    SELECT 'strategies_to_add: ' || COUNT(*) FROM src.trader_strategies WHERE id NOT IN (SELECT id FROM trader_strategies);
    SELECT 'signals_to_add:    ' || COUNT(*) FROM src.trader_signals    WHERE id NOT IN (SELECT id FROM trader_signals);
    SELECT 'decisions_to_add:  ' || COUNT(*) FROM src.trader_decisions  WHERE id NOT IN (SELECT id FROM trader_decisions);
    SELECT 'executed_to_add:   ' || COUNT(*) FROM src.trader_decisions  WHERE status='executed' AND id NOT IN (SELECT id FROM trader_decisions);
    DETACH src;\"; rm -f '$REMOTE_SNAP'"
  echo "(no changes written)"
  exit 0
fi

echo "Applying additive sync to server..."
ssh -o ConnectTimeout=20 "$DASHBOARD_HOST" "
  set -e
  # Ensure server trader_decisions has engine_order_id (ALTER-added locally).
  HAS_COL=\$(sqlite3 '$REMOTE_DB' \"SELECT COUNT(*) FROM pragma_table_info('trader_decisions') WHERE name='engine_order_id';\")
  if [ \"\$HAS_COL\" = \"0\" ]; then
    echo '  + adding missing column trader_decisions.engine_order_id on server'
    sqlite3 '$REMOTE_DB' 'ALTER TABLE trader_decisions ADD COLUMN engine_order_id TEXT;'
  fi
  echo '  before:' \$(sqlite3 '$REMOTE_DB' \"SELECT 'signals='||(SELECT COUNT(*) FROM trader_signals)||' decisions='||(SELECT COUNT(*) FROM trader_decisions)||' approvals='||(SELECT COUNT(*) FROM trader_approvals);\")
  sqlite3 '$REMOTE_DB' \"
    .timeout 8000
    ATTACH '$REMOTE_SNAP' AS src;
    BEGIN;
    INSERT OR IGNORE INTO trader_strategies ($STR_COLS) SELECT $STR_COLS FROM src.trader_strategies;
    INSERT OR IGNORE INTO trader_signals    ($SIG_COLS) SELECT $SIG_COLS FROM src.trader_signals;
    INSERT OR IGNORE INTO trader_decisions  ($DEC_COLS) SELECT $DEC_COLS FROM src.trader_decisions;
    COMMIT;
    DETACH src;\"
  echo '  after: ' \$(sqlite3 '$REMOTE_DB' \"SELECT 'signals='||(SELECT COUNT(*) FROM trader_signals)||' decisions='||(SELECT COUNT(*) FROM trader_decisions)||' approvals='||(SELECT COUNT(*) FROM trader_approvals);\")
  rm -f '$REMOTE_SNAP'
"
echo "Trader DB sync complete (additive; approvals untouched)."
