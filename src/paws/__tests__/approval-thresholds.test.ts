// src/paws/__tests__/retrain-regime-threshold.test.ts
//
// Tests for enforcePawApprovalThresholds() in src/paws/index.ts.
//
// The retrain Paw's ACT phase SSHes to the engine host, rotates the model
// joblib and runs `sudo systemctl restart trader-engine`. Threshold 4 keeps
// that behind operator approval; anything above max severity (5) un-gates it.
// The production row had drifted to 6, so this reconciles at boot.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { initPawsTables } from '../db.js'
import {
  enforcePawApprovalThresholds,
  TRAIN_REGIME_APPROVAL_THRESHOLD,
} from '../index.js'
import { trainRegimePawConfig } from '../trader-retrain-regime.js'

vi.mock('../../scheduler.js', () => ({
  computeNextRun: (_cron: string) => 4070908800000, // 2099-01-01T00:00:00Z in ms
}))

let db: InstanceType<typeof Database>

function insertRetrainPaw(threshold: number): void {
  db.prepare(`
    INSERT INTO paws (id, project_id, name, agent_id, cron, status, config, next_run, created_at)
    VALUES (?, ?, ?, 'auditor', ?, 'active', ?, 0, ?)
  `).run(
    trainRegimePawConfig.id,
    trainRegimePawConfig.project_id,
    trainRegimePawConfig.name,
    trainRegimePawConfig.schedule,
    JSON.stringify({ chat_id: '99999', approval_threshold: threshold, approval_timeout_sec: 3600 }),
    Date.now(),
  )
}

function readThreshold(): number | undefined {
  const row = db
    .prepare("SELECT json_extract(config, '$.approval_threshold') AS t FROM paws WHERE id = ?")
    .get(trainRegimePawConfig.id) as { t: number } | undefined
  return row?.t
}

beforeEach(() => {
  db = new Database(':memory:')
  initPawsTables(db)
})

afterEach(() => {
  db.close()
})

describe('enforcePawApprovalThresholds', () => {
  it('is 4, below max severity 5, so the ACT phase stays gated', () => {
    expect(TRAIN_REGIME_APPROVAL_THRESHOLD).toBe(4)
    expect(TRAIN_REGIME_APPROVAL_THRESHOLD).toBeLessThanOrEqual(5)
  })

  it('resets a drifted threshold of 6 back to 4', () => {
    insertRetrainPaw(6)
    enforcePawApprovalThresholds(db)
    expect(readThreshold()).toBe(TRAIN_REGIME_APPROVAL_THRESHOLD)
  })

  it('leaves an already-correct threshold alone', () => {
    insertRetrainPaw(TRAIN_REGIME_APPROVAL_THRESHOLD)
    enforcePawApprovalThresholds(db)
    expect(readThreshold()).toBe(TRAIN_REGIME_APPROVAL_THRESHOLD)
  })

  it('preserves the rest of the config when it rewrites the threshold', () => {
    insertRetrainPaw(6)
    enforcePawApprovalThresholds(db)
    const row = db
      .prepare('SELECT config FROM paws WHERE id = ?')
      .get(trainRegimePawConfig.id) as { config: string }
    const config = JSON.parse(row.config)
    expect(config.chat_id).toBe('99999')
    expect(config.approval_timeout_sec).toBe(3600)
  })

  it('is a no-op when the paw has never been seeded', () => {
    expect(() => enforcePawApprovalThresholds(db)).not.toThrow()
    expect(readThreshold()).toBeUndefined()
  })

  // The old version only logged to pino, which is why the prod drift from 4 to
  // 6 went unnoticed. Returning the corrections is what makes it reportable.
  it('reports what it corrected so the drift cannot stay silent', () => {
    insertRetrainPaw(6)
    const corrections = enforcePawApprovalThresholds(db)
    expect(corrections).toEqual([
      { pawId: trainRegimePawConfig.id, from: 6, to: TRAIN_REGIME_APPROVAL_THRESHOLD },
    ])
  })

  it('reports nothing when there is no drift', () => {
    insertRetrainPaw(TRAIN_REGIME_APPROVAL_THRESHOLD)
    expect(enforcePawApprovalThresholds(db)).toEqual([])
  })
})
