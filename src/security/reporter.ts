// src/security/reporter.ts
import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { BOT_API_TOKEN, DASHBOARD_URL } from '../config.js';
import { computeScore } from './types.js';
import { fireSecurityFinding } from '../webhooks/index.js';
import {
  upsertFindings,
  recordScan,
  snapshotScore,
  getScoreHistory,
  getOpenFindings,
  getRecentScans,
} from './persistence.js';
import type { SuiteResult } from './registry.js';
import type {
  ScanScope,
  ScanTrigger,
  ScanRecord,
  AutoFixResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SendFn = (chatId: string, text: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Main report entry point
// ---------------------------------------------------------------------------

export async function processAndReport(
  suiteResult: SuiteResult,
  scope: ScanScope,
  trigger: ScanTrigger,
  autoFixResults: AutoFixResult[],
  chatId: string,
  sendFn: SendFn,
): Promise<void> {
  // 1. Persist all findings + fire webhooks
  if (suiteResult.findings.length > 0) {
    upsertFindings(suiteResult.findings);
    for (const f of suiteResult.findings) {
      fireSecurityFinding({
        finding_id: f.id,
        scanner_id: f.scannerId,
        severity: f.severity,
        title: f.title,
        target: f.target,
      }, 'default');
    }
  }

  // 2. Record each scanner's scan
  for (const [scannerId, result] of suiteResult.scanResults) {
    const scan: ScanRecord = {
      id: randomUUID(),
      scannerId,
      startedAt: Math.floor(Date.now() / 1000),
      durationMs: result.durationMs,
      findingsCount: result.findings.length,
      trigger,
    };
    recordScan(scan);
  }

  // 3. Snapshot score
  const scoreSnap = snapshotScore();
  const prevHistory = getScoreHistory(2);
  const prevScore = prevHistory.length > 1 ? prevHistory[1].score : null;

  // 4. Send a concise summary only when the scan found issues or scanner failures.
  if (suiteResult.findings.length > 0 || suiteResult.errors.size > 0) {
    const summary = buildTelegramSummary(
      suiteResult,
      scope,
      scoreSnap.score,
      prevScore,
      autoFixResults,
    );
    try {
      await sendFn(chatId, summary);
    } catch (err) {
      logger.error({ err }, 'Failed to send security scan summary');
    }
  }

  // 5. Send urgent alerts for critical/high
  const urgent = suiteResult.findings.filter(
    (f) => f.severity === 'critical' || f.severity === 'high',
  );
  for (const finding of urgent) {
    const alert = buildUrgentAlert(finding);
    try {
      await sendFn(chatId, alert);
    } catch (err) {
      logger.error({ err, findingId: finding.id }, 'Failed to send urgent alert');
    }
  }

  // 6. Sync to dashboard server
  await syncToDashboard(suiteResult, scope, trigger);
}

// ---------------------------------------------------------------------------
// Telegram message builders
// ---------------------------------------------------------------------------

function buildTelegramSummary(
  result: SuiteResult,
  scope: ScanScope,
  score: number,
  prevScore: number | null,
  autoFixResults: AutoFixResult[],
): string {
  const title = scope === 'weekly' ? 'Weekly security audit' : 'Daily security scan';
  const totalIssues = result.findings.length;
  const urgentIssues = result.findings.filter(
    (f) => f.severity === 'critical' || f.severity === 'high',
  ).length;
  const scannerErrors = result.errors.size;
  const lines: string[] = [`Issue: ${title} found ${totalIssues} issue${totalIssues === 1 ? '' : 's'}.`];

  if (urgentIssues > 0) {
    lines.push(`Urgent: ${urgentIssues} critical/high.`);
  }

  if (scannerErrors > 0) {
    lines.push(`Scanner errors: ${scannerErrors}.`);
  }

  let scoreLine = `Score: ${score}/100`;
  if (prevScore !== null) {
    const delta = score - prevScore;
    if (delta > 0) scoreLine += ` (+${delta})`;
    else if (delta < 0) scoreLine += ` (${delta})`;
    else scoreLine += ' (unchanged)';
  }
  lines.push(scoreLine);

  const fixSucceeded = autoFixResults.filter((r) => r.success).length;
  if (autoFixResults.length > 0) {
    lines.push(`Auto-fixed: ${fixSucceeded}/${autoFixResults.length}.`);
  }

  lines.push(`Open: ${DASHBOARD_URL.replace(/\/$/, '')}/#errors`);

  return lines.join('\n');
}

function buildUrgentAlert(finding: import('./types.js').Finding): string {
  const label = finding.severity.toUpperCase();
  const lines = [
    `${label} finding`,
    `${finding.scannerId}: ${finding.title}`,
    `Target: ${finding.target}`,
  ];

  if (finding.description) {
    lines.push(`Detail: ${finding.description.slice(0, 200)}`);
  }

  lines.push(`Auto-fix: ${finding.autoFixable ? 'available' : 'not available'}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Build security context for soul injection
// ---------------------------------------------------------------------------

export function buildSecurityContext(): string {
  try {
    const openFindings = getOpenFindings();
    const score = computeScore(openFindings);
    const recentScans = getRecentScans(5);

    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of openFindings) {
      counts[f.severity]++;
    }

    const lines: string[] = [
      '[Current Security Status]',
      `Score: ${score}/100`,
      `Open findings: ${openFindings.length} (${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low)`,
    ];

    // Last scan info
    if (recentScans.length > 0) {
      const last = recentScans[0];
      const date = new Date(last.startedAt * 1000).toISOString().replace('T', ' ').slice(0, 16);
      lines.push(`Last scan: ${date} (${last.scannerId}, ${last.findingsCount} findings)`);
    }

    // Open findings list
    if (openFindings.length > 0) {
      lines.push('');
      lines.push('[Open Findings]');
      for (let i = 0; i < Math.min(openFindings.length, 15); i++) {
        const f = openFindings[i];
        lines.push(
          `${i + 1}. [${f.severity.toUpperCase()}] ${f.scannerId}: ${f.title} (target: ${f.target})`,
        );
      }
      if (openFindings.length > 15) {
        lines.push(`... and ${openFindings.length - 15} more`);
      }
    }

    return lines.join('\n');
  } catch (err) {
    logger.error({ err }, 'Failed to build security context');
    return '[Security context unavailable]';
  }
}

// ---------------------------------------------------------------------------
// Dashboard sync via REST
// ---------------------------------------------------------------------------

async function syncToDashboard(
  suiteResult: SuiteResult,
  scope: ScanScope,
  trigger: ScanTrigger,
): Promise<void> {
  const baseUrl = DASHBOARD_URL.replace(/\/$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // BOT_API_TOKEN falls back to DASHBOARD_API_TOKEN in config.ts
  if (BOT_API_TOKEN) headers['x-dashboard-token'] = BOT_API_TOKEN;

  try {
    // Sync findings
    if (suiteResult.findings.length > 0) {
      await fetch(`${baseUrl}/api/v1/security/findings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ findings: suiteResult.findings }),
      });
    }

    // Sync scans
    for (const [scannerId, result] of suiteResult.scanResults) {
      await fetch(`${baseUrl}/api/v1/security/scans`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: randomUUID(),
          scanner_id: scannerId,
          started_at: Math.floor(Date.now() / 1000),
          duration_ms: result.durationMs,
          findings_count: result.findings.length,
          trigger,
        }),
      });
    }

    // Sync score
    const scoreSnap = getScoreHistory(1);
    if (scoreSnap.length > 0) {
      await fetch(`${baseUrl}/api/v1/security/score`, {
        method: 'POST',
        headers,
        body: JSON.stringify(scoreSnap[0]),
      }).catch(() => { /* score endpoint may not exist yet */ });
    }

    logger.info('Security results synced to dashboard server');
  } catch (err) {
    logger.warn({ err }, 'Failed to sync security results to dashboard (non-fatal)');
  }
}
