# fullreview loop 1 — scope: security,backend — diff origin/main..HEAD
Baseline: server tsc clean, 80/80 route tests green.

## CRITICAL
(none)

## HIGH
(none)

## MEDIUM
1. [FIX NOW] 8mb express.json global, parsed before auth and rate limiting (index.ts:70).
   Both reviewers. Fix: scope 8mb parser to /api/v1/internal/*, restore 1mb global.
2. [FIX NOW] Potential double-count if engine /orders returns partial+full snapshots of the
   same order (status.ts fifo input; also go-live-gate.ts). Fix: dedup by client_order_id
   keeping max filled_qty before FIFO, both places.
3. [DEFER -> task #10] updated_at is order-update time, not fill time; mis-sort can drop
   round-trips. Shared by all three implementations. Needs engine-side fill timestamp.

## LOW
4. [FIX NOW] broker-pnl echoes raw error string to client (status.ts). Fix: generic message.
5. [SKIP] KPI cell order race (cosmetic, pre-existing pattern).
6. [SKIP] stale realized cell during outage (defensible; halt banner covers outage state).
7. [SKIP] verify-trader-pnl.mjs lacks status lowercase (reference script, flagged only).

## Test gaps addressed
- broker-pnl FIFO + dedup unit test; /status reconciler_halted passthrough assertion.
