// src/security/index.ts -- Barrel module for the security scanner system
import { logger } from '../logger.js';
import {
  SECURITY_PROJECT_PATHS,
  SECURITY_DOMAINS,
  SECURITY_TAILSCALE_NODES,
  SECURITY_GITHUB_OWNER,
  SECURITY_EXPECTED_PORTS,
} from '../config.js';
import { loadScanners, runSuite, runScanner } from './registry.js';
import { runAutoFixes } from './auto-fix.js';
import { processAndReport, buildSecurityContext } from './reporter.js';
import {
  upsertFindings,
  recordScan,
  snapshotScore,
  getOpenFindings,
  getScoreHistory,
  getAllFindings,
  updateFindingStatus,
} from './persistence.js';
import type { ScanScope, ScanTrigger, ScanContext } from './types.js';
import { fireSecurityFinding } from '../webhooks/index.js';

// ---------------------------------------------------------------------------
// Re-exports for external consumers
// ---------------------------------------------------------------------------

export {
  buildSecurityContext,
  getOpenFindings,
  snapshotScore,
  getScoreHistory,
  getAllFindings,
  updateFindingStatus,
};

// ---------------------------------------------------------------------------
// Build ScanContext from config
// ---------------------------------------------------------------------------

function buildScanContext(): ScanContext {
  return {
    projectPaths: SECURITY_PROJECT_PATHS,
    tailscaleNodes: SECURITY_TAILSCALE_NODES,
    domains: SECURITY_DOMAINS,
    githubOwner: SECURITY_GITHUB_OWNER,
    expectedPorts: SECURITY_EXPECTED_PORTS,
  };
}

// ---------------------------------------------------------------------------
// Init -- call once at startup
// ---------------------------------------------------------------------------

export function initSecurity(): void {
  loadScanners();
  logger.info('Security scanner system initialized');
}

// ---------------------------------------------------------------------------
// Execute a full scan suite (daily or weekly)
// ---------------------------------------------------------------------------

type SendFn = (chatId: string, text: string) => Promise<void>;

export async function executeSecurityScan(
  scope: ScanScope,
  trigger: ScanTrigger,
  chatId: string,
  sendFn: SendFn,
): Promise<string> {
  const context = buildScanContext();

  logger.info({ scope, trigger }, 'Executing security scan');

  // Run the suite
  const suiteResult = await runSuite(scope, context);

  // Run auto-fixes on eligible findings
  const autoFixResults = await runAutoFixes(suiteResult.findings);

  // Persist, report, sync
  await processAndReport(suiteResult, scope, trigger, autoFixResults, chatId, sendFn);

  // Return a summary string for scheduler logging
  const totalFindings = suiteResult.findings.length;
  const errors = suiteResult.errors.size;
  const fixes = autoFixResults.filter((r) => r.success).length;
  return `Security ${scope} scan complete: ${totalFindings} findings, ${fixes} auto-fixed, ${errors} scanner errors. Duration: ${suiteResult.totalDurationMs}ms`;
}

// ---------------------------------------------------------------------------
// Execute a single scanner (for manual/dashboard triggers)
// ---------------------------------------------------------------------------

export async function executeSingleScan(
  scannerId: string,
  chatId: string,
  sendFn: SendFn,
): Promise<string> {
  const context = buildScanContext();

  logger.info({ scannerId }, 'Executing single scanner');

  const result = await runScanner(scannerId, context);

  // Persist findings + fire webhooks
  if (result.findings.length > 0) {
    upsertFindings(result.findings);
    for (const f of result.findings) {
      fireSecurityFinding({
        finding_id: f.id,
        scanner_id: scannerId,
        severity: f.severity,
        title: f.title,
        target: f.target,
      }, 'default');
    }
  }

  // Record the scan
  const { randomUUID } = await import('node:crypto');
  recordScan({
    id: randomUUID(),
    scannerId,
    startedAt: Math.floor(Date.now() / 1000),
    durationMs: result.durationMs,
    findingsCount: result.findings.length,
    trigger: 'manual',
  });

  // Snapshot score
  snapshotScore();

  // Send summary
  const summary = `\u{1F6E1}\u{FE0F} **${scannerId}** scan complete\n\n${result.summary}\nFindings: ${result.findings.length} | Duration: ${(result.durationMs / 1000).toFixed(1)}s`;
  try {
    await sendFn(chatId, summary);
  } catch (err) {
    logger.error({ err }, 'Failed to send single scan summary');
  }

  return summary;
}
