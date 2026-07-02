# loop 1 fixes (applied, verified)
- index.ts: 8mb JSON parser scoped to /api/v1/internal only; global back to 1mb.
- status.ts broker-pnl + go-live-gate.ts computeBrokerTruth: dedup orders by
  client_order_id (keep max filled_qty) before FIFO so a partial+full snapshot
  pair never double-counts realized P&L.
- status.ts broker-pnl catch: generic 'engine unreachable' instead of String(err).
- Tests: broker-pnl FIFO+dedup+generic-error (2 new), /status halt passthrough
  assertions, gate test now covers dedup. Server 82/82, bot 1840/1840, tsc clean.
Deferred: updated_at vs true fill time -> task #10 (engine-side).
Skipped LOW: KPI order race, stale-cell marker, verify script lowercase (noted).
