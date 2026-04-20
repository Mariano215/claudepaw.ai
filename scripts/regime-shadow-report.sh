#!/bin/bash
# Phase 6 Task 1 -- XGBoost regime flip diagnostic.
#
# Runs the three key queries from docs/trader/runbook-regime.md against the
# engine's regime_predictions.db and prints a PASS / FAIL verdict against
# the flip criteria (agreement >= 95%, no systemic one-sided disagreement).
#
# Usage:
#   scripts/regime-shadow-report.sh [days]
#
#   days defaults to 28 (the 4-week flip window). Pass 7 for a weekly
#   health check.
#
# Exit 0 when PASS, exit 1 when FAIL or when inspection is inconclusive
# (e.g. not enough samples). This makes the script cron-safe for a
# future automated flip-ready alert.

set -euo pipefail

DAYS="${1:-28}"
ENGINE_HOST="${ENGINE_HOST:-localhost-wsl-ubuntu}"
ENGINE_USER="${ENGINE_USER:-mariano}"
DB_PATH="${REGIME_DB_PATH:-~/Projects/trader-engine/models/regime_predictions.db}"

SSH_TARGET="${ENGINE_USER}@${ENGINE_HOST}"

echo "Regime shadow report"
echo "  window:  ${DAYS} days"
echo "  engine:  ${SSH_TARGET}"
echo "  db:      ${DB_PATH}"
echo ""

# -- Row count -------------------------------------------------------------

cutoff_sql="ts_ms > (strftime('%s','now','-${DAYS} days') * 1000)"

total=$(ssh -o ConnectTimeout=10 "${SSH_TARGET}" \
  "sqlite3 ${DB_PATH} \"SELECT COUNT(*) FROM regime_predictions WHERE ${cutoff_sql}\"" 2>/dev/null || echo 0)
with_xgb=$(ssh -o ConnectTimeout=10 "${SSH_TARGET}" \
  "sqlite3 ${DB_PATH} \"SELECT COUNT(*) FROM regime_predictions WHERE ${cutoff_sql} AND xgb_label IS NOT NULL\"" 2>/dev/null || echo 0)

echo "Sample count"
echo "  total rows:           ${total}"
echo "  rows with xgb_label:  ${with_xgb}"
echo ""

if [ "${total:-0}" -lt 100 ]; then
  echo "INCONCLUSIVE: fewer than 100 samples in window. Shadow log is either fresh or not recording. Check engine logs for regime.shadow_log.append_failed."
  exit 1
fi

# -- Agreement rate --------------------------------------------------------

agreement_pct=$(ssh -o ConnectTimeout=10 "${SSH_TARGET}" \
  "sqlite3 ${DB_PATH} \"SELECT ROUND(100.0 * SUM(CASE WHEN rule_label = xgb_label THEN 1 ELSE 0 END) / COUNT(*), 2) FROM regime_predictions WHERE ${cutoff_sql} AND xgb_label IS NOT NULL\"" 2>/dev/null || echo "0")

echo "Agreement rate"
echo "  rule == xgb:  ${agreement_pct}%"
echo "  threshold:    95.00%"
echo ""

# -- Confusion matrix ------------------------------------------------------

echo "Confusion matrix (rule x xgb)"
ssh -o ConnectTimeout=10 "${SSH_TARGET}" "sqlite3 -header -column ${DB_PATH} \"SELECT rule_label, xgb_label, COUNT(*) AS n FROM regime_predictions WHERE ${cutoff_sql} GROUP BY rule_label, xgb_label ORDER BY n DESC\"" 2>/dev/null || true
echo ""

# -- Recent disagreements --------------------------------------------------

echo "Most recent disagreements (up to 10)"
ssh -o ConnectTimeout=10 "${SSH_TARGET}" "sqlite3 -header -column ${DB_PATH} \"SELECT ts_ms, rule_label, xgb_label FROM regime_predictions WHERE ${cutoff_sql} AND rule_label != xgb_label ORDER BY ts_ms DESC LIMIT 10\"" 2>/dev/null || true
echo ""

# -- Verdict ---------------------------------------------------------------

awk_check=$(awk -v p="${agreement_pct:-0}" 'BEGIN { exit !(p+0 >= 95.0) }' && echo "ok" || echo "fail")

if [ "${awk_check}" = "ok" ]; then
  echo "VERDICT: PASS. Agreement above threshold. Eyeball the disagreements above for systemic clusters before flipping TRADER_REGIME_USE_XGB=true."
  exit 0
else
  echo "VERDICT: FAIL. Agreement below 95% threshold. Do NOT flip the flag. Inspect the confusion matrix and retrain if a class is systematically diverging."
  exit 1
fi
