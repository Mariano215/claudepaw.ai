// src/security/scanners/secret-scan.ts
// Scans project repos for leaked secrets using gitleaks

import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecurityScanner, ScanContext, ScanResult } from '../types.js';
import { createFinding } from '../types.js';

interface GitleaksLeak {
  Description: string;
  File: string;
  StartLine: number;
  Commit: string;
  Author: string;
  RuleID: string;
  Match: string;
  Secret: string;
}

function runGitleaks(projectPath: string): Promise<GitleaksLeak[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'gitleaks',
      ['detect', '--source', projectPath, '--report-format', 'json', '--no-banner'],
      { maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, _stderr) => {
        // gitleaks exits with code 1 when leaks are found, 0 when clean
        if (error && error.code !== 1) {
          // code 1 = leaks found (expected), anything else is a real error
          if (error.killed) {
            reject(new Error(`gitleaks timed out for ${projectPath}`));
            return;
          }
          // If gitleaks is not installed or another error
          reject(new Error(`gitleaks failed for ${projectPath}: ${error.message}`));
          return;
        }

        if (!stdout || stdout.trim().length === 0) {
          resolve([]);
          return;
        }

        // gitleaks JSON output may have extra text before the array
        const jsonStart = stdout.indexOf('[');
        if (jsonStart === -1) {
          resolve([]);
          return;
        }

        try {
          const leaks: GitleaksLeak[] = JSON.parse(stdout.slice(jsonStart));
          resolve(Array.isArray(leaks) ? leaks : []);
        } catch {
          resolve([]);
        }
      }
    );
  });
}

async function hasGitDir(projectPath: string): Promise<boolean> {
  try {
    await access(join(projectPath, '.git'), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const scanner: SecurityScanner = {
  id: 'secret-scan',
  name: 'Secret Scanner',
  description: 'Scans git repositories for leaked secrets, API keys, and credentials using gitleaks',
  scope: 'weekly',

  async run(context: ScanContext): Promise<ScanResult> {
    const start = Date.now();
    const findings = [];
    const errors: string[] = [];

    for (const projectPath of context.projectPaths) {
      const isGitRepo = await hasGitDir(projectPath);
      if (!isGitRepo) continue;

      try {
        const leaks = await runGitleaks(projectPath);
        for (const leak of leaks) {
          findings.push(
            createFinding({
              scannerId: 'secret-scan',
              severity: 'critical',
              title: `Secret detected: ${leak.RuleID}`,
              description: `${leak.Description} in ${leak.File}:${leak.StartLine} (commit ${leak.Commit?.slice(0, 8) ?? 'unknown'})`,
              target: `${projectPath}/${leak.File}`,
              autoFixable: false,
              metadata: {
                ruleId: leak.RuleID,
                file: leak.File,
                line: leak.StartLine,
                commit: leak.Commit,
                author: leak.Author,
              },
            })
          );
        }
      } catch (err) {
        errors.push(`${projectPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const durationMs = Date.now() - start;
    const errorSuffix = errors.length > 0 ? ` (${errors.length} errors: ${errors.join('; ')})` : '';

    return {
      findings,
      summary: `Secret scan complete: ${findings.length} leaked secrets found across ${context.projectPaths.length} projects${errorSuffix}`,
      durationMs,
    };
  },
};

export default scanner;
