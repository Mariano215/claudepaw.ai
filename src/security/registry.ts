// src/security/registry.ts
import { logger } from '../logger.js';
import type {
  SecurityScanner,
  ScanScope,
  ScanContext,
  ScanResult,
  Finding,
} from './types.js';

import npmAuditScanner from './scanners/npm-audit.js';
import tailscaleHealthScanner from './scanners/tailscale-health.js';
import sslCheckScanner from './scanners/ssl-check.js';
import secretScanScanner from './scanners/secret-scan.js';
import portScanScanner from './scanners/port-scan.js';
import githubAuditScanner from './scanners/github-audit.js';

// ---------------------------------------------------------------------------
// Scanner Map
// ---------------------------------------------------------------------------

const scanners = new Map<string, SecurityScanner>();

export function loadScanners(): void {
  const all: SecurityScanner[] = [
    npmAuditScanner,
    tailscaleHealthScanner,
    sslCheckScanner,
    secretScanScanner,
    portScanScanner,
    githubAuditScanner,
  ];
  for (const s of all) {
    scanners.set(s.id, s);
    logger.info({ scannerId: s.id, scope: s.scope }, 'Registered scanner');
  }
}

export function getScanner(id: string): SecurityScanner | undefined {
  return scanners.get(id);
}

export function getAllScanners(): SecurityScanner[] {
  return Array.from(scanners.values());
}

// ---------------------------------------------------------------------------
// Suite Result
// ---------------------------------------------------------------------------

export interface SuiteResult {
  findings: Finding[];
  scanResults: Map<string, ScanResult>;
  errors: Map<string, Error>;
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// Run Suite -- parallel execution of all scanners matching the scope
// ---------------------------------------------------------------------------

export async function runSuite(
  scope: ScanScope,
  context: ScanContext,
): Promise<SuiteResult> {
  const start = Date.now();

  // Weekly scope includes ALL scanners; daily only includes daily-scoped ones
  const eligible = getAllScanners().filter(
    (s) => scope === 'weekly' || s.scope === scope,
  );

  logger.info(
    { scope, count: eligible.length },
    'Starting security suite',
  );

  const settled = await Promise.allSettled(
    eligible.map(async (scanner) => {
      const result = await scanner.run(context);
      return { id: scanner.id, result };
    }),
  );

  const findings: Finding[] = [];
  const scanResults = new Map<string, ScanResult>();
  const errors = new Map<string, Error>();

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const scannerId = eligible[i].id;

    if (outcome.status === 'fulfilled') {
      scanResults.set(scannerId, outcome.value.result);
      findings.push(...outcome.value.result.findings);
      logger.info(
        {
          scannerId,
          findings: outcome.value.result.findings.length,
          durationMs: outcome.value.result.durationMs,
        },
        'Scanner completed',
      );
    } else {
      const err =
        outcome.reason instanceof Error
          ? outcome.reason
          : new Error(String(outcome.reason));
      errors.set(scannerId, err);
      logger.error(
        { scannerId, err: err.message },
        'Scanner failed',
      );
    }
  }

  const totalDurationMs = Date.now() - start;
  logger.info(
    {
      scope,
      totalFindings: findings.length,
      succeeded: scanResults.size,
      failed: errors.size,
      totalDurationMs,
    },
    'Security suite complete',
  );

  return { findings, scanResults, errors, totalDurationMs };
}

// ---------------------------------------------------------------------------
// Run Single Scanner
// ---------------------------------------------------------------------------

export async function runScanner(
  id: string,
  context: ScanContext,
): Promise<ScanResult> {
  const scanner = scanners.get(id);
  if (!scanner) {
    throw new Error(`Unknown scanner: ${id}`);
  }

  logger.info({ scannerId: id }, 'Running single scanner');
  const result = await scanner.run(context);
  logger.info(
    { scannerId: id, findings: result.findings.length, durationMs: result.durationMs },
    'Single scanner completed',
  );
  return result;
}
