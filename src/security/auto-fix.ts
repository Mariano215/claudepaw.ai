// src/security/auto-fix.ts
import { logger } from '../logger.js';
import { SECURITY_AUTO_FIX_MAX_SEVERITY } from '../config.js';
import { getScanner } from './registry.js';
import { logAutoFix } from './persistence.js';
import type {
  Finding,
  Severity,
  AutoFixResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Severity ordering for threshold comparison
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function severityAtOrBelow(severity: Severity, threshold: string): boolean {
  const thresholdRank = SEVERITY_RANK[threshold as Severity] ?? 2;
  return SEVERITY_RANK[severity] <= thresholdRank;
}

// ---------------------------------------------------------------------------
// Run auto-fixes on eligible findings
// ---------------------------------------------------------------------------

export async function runAutoFixes(findings: Finding[]): Promise<AutoFixResult[]> {
  const eligible = findings.filter(
    (f) =>
      f.autoFixable &&
      f.status === 'open' &&
      severityAtOrBelow(f.severity, SECURITY_AUTO_FIX_MAX_SEVERITY),
  );

  if (eligible.length === 0) {
    logger.info('Auto-fix: no eligible findings');
    return [];
  }

  logger.info(
    { count: eligible.length, maxSeverity: SECURITY_AUTO_FIX_MAX_SEVERITY },
    'Auto-fix: processing eligible findings',
  );

  // Group findings by scanner
  const byScanner = new Map<string, Finding[]>();
  for (const f of eligible) {
    const group = byScanner.get(f.scannerId) ?? [];
    group.push(f);
    byScanner.set(f.scannerId, group);
  }

  const allResults: AutoFixResult[] = [];

  for (const [scannerId, scannerFindings] of byScanner) {
    const scanner = getScanner(scannerId);
    if (!scanner?.autoFix) {
      logger.debug({ scannerId }, 'Scanner has no autoFix method, skipping');
      continue;
    }

    try {
      logger.info(
        { scannerId, count: scannerFindings.length },
        'Running auto-fix for scanner',
      );

      const results = await scanner.autoFix(scannerFindings);

      for (const result of results) {
        logAutoFix(
          result.findingId,
          scannerId,
          'auto-fix',
          result.success,
          result.description,
        );

        if (result.success) {
          logger.info(
            { scannerId, findingId: result.findingId },
            'Auto-fix succeeded',
          );
        } else {
          logger.warn(
            { scannerId, findingId: result.findingId, desc: result.description },
            'Auto-fix failed',
          );
        }
      }

      allResults.push(...results);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ scannerId, err: errMsg }, 'Auto-fix batch failed');

      for (const f of scannerFindings) {
        logAutoFix(f.id, scannerId, 'batch auto-fix', false, errMsg);
        allResults.push({
          findingId: f.id,
          success: false,
          description: `Auto-fix error: ${errMsg}`,
        });
      }
    }
  }

  const succeeded = allResults.filter((r) => r.success).length;
  logger.info(
    { total: allResults.length, succeeded, failed: allResults.length - succeeded },
    'Auto-fix complete',
  );

  return allResults;
}
