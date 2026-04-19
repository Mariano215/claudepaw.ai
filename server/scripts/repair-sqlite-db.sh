#!/bin/bash
# Repair a SQLite database in place by exporting recoverable rows into a fresh
# file, verifying integrity, and then atomically replacing the original.
set -euo pipefail

DB_PATH="${1:-/opt/claudepaw-server/store/telemetry.db}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required"
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "Database not found: $DB_PATH"
  exit 1
fi

DB_DIR="$(cd "$(dirname "$DB_PATH")" && pwd)"
DB_NAME="$(basename "$DB_PATH")"
STAMP="$(date '+%Y%m%d-%H%M%S')"
BACKUP_PATH="$DB_DIR/$DB_NAME.corrupt.$STAMP"
TEMP_DIR="$(mktemp -d "/tmp/${DB_NAME%.db}-repair-XXXXXX")"
SQL_PATH="$TEMP_DIR/recover.sql"
FIXED_PATH="$TEMP_DIR/$DB_NAME.fixed"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "Checking integrity for $DB_PATH..."
if sqlite3 "$DB_PATH" "PRAGMA integrity_check;" 2>/dev/null | head -n1 | grep -q '^ok$'; then
  echo "Database is already healthy."
  exit 0
fi

echo "Backing up original database to $BACKUP_PATH"
cp -p "$DB_PATH" "$BACKUP_PATH"
rm -f "$DB_PATH-wal" "$DB_PATH-shm"

echo "Attempting recovery with .recover..."
if ! sqlite3 "$DB_PATH" ".recover" >"$SQL_PATH" 2>/dev/null; then
  echo ".recover failed; trying .dump..."
  sqlite3 "$DB_PATH" ".mode insert" ".output $SQL_PATH" ".dump"
fi

echo "Rebuilding fresh database..."
sqlite3 "$FIXED_PATH" <"$SQL_PATH"

echo "Verifying rebuilt database..."
if ! sqlite3 "$FIXED_PATH" "PRAGMA integrity_check;" 2>/dev/null | head -n1 | grep -q '^ok$'; then
  echo "Rebuilt database failed integrity check. Original left in place at $DB_PATH"
  exit 1
fi

mv "$DB_PATH" "$DB_PATH.bad.$STAMP"
mv "$FIXED_PATH" "$DB_PATH"
chmod 600 "$DB_PATH" 2>/dev/null || true

echo "Repair complete."
echo "Original backup: $BACKUP_PATH"
echo "Previous live file: $DB_PATH.bad.$STAMP"
echo "Repaired database: $DB_PATH"
