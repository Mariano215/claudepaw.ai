// src/security/scanners/github-audit.ts
// Audits GitHub repos for Dependabot and secret scanning alerts using the gh CLI

import { execFile } from 'node:child_process';
import type { SecurityScanner, ScanContext, ScanResult, Severity } from '../types.js';
import { createFinding } from '../types.js';

interface GhRepo {
  name: string;
  isPrivate: boolean;
  url: string;
}

interface DependabotAlert {
  number: number;
  state: string;
  security_advisory?: {
    summary?: string;
    description?: string;
    severity?: string;
    cve_id?: string;
  };
  security_vulnerability?: {
    package?: { name?: string; ecosystem?: string };
    severity?: string;
    vulnerable_version_range?: string;
  };
  dependency?: {
    package?: { name?: string; ecosystem?: string };
    manifest_path?: string;
  };
  html_url?: string;
}

interface SecretScanningAlert {
  number: number;
  state: string;
  secret_type_display_name?: string;
  secret_type?: string;
  html_url?: string;
  created_at?: string;
}

function execGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function mapGitHubSeverity(severity: string | undefined): Severity {
  switch (severity?.toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
    case 'moderate':
      return 'medium';
    case 'low':
      return 'low';
    default:
      return 'medium';
  }
}

async function listRepos(owner: string): Promise<GhRepo[]> {
  const stdout = await execGh([
    'repo', 'list', owner,
    '--json', 'name,isPrivate,url',
    '--limit', '100',
  ]);

  try {
    const repos: GhRepo[] = JSON.parse(stdout);
    return Array.isArray(repos) ? repos : [];
  } catch {
    return [];
  }
}

async function getDependabotAlerts(owner: string, repo: string): Promise<DependabotAlert[]> {
  try {
    const stdout = await execGh([
      'api',
      `repos/${owner}/${repo}/dependabot/alerts`,
      '--jq', '[.[] | select(.state=="open")]',
    ]);

    if (!stdout || stdout.trim().length === 0) return [];

    const alerts: DependabotAlert[] = JSON.parse(stdout);
    return Array.isArray(alerts) ? alerts : [];
  } catch {
    // Dependabot may not be enabled on this repo, or insufficient permissions
    return [];
  }
}

async function getSecretScanningAlerts(owner: string, repo: string): Promise<SecretScanningAlert[]> {
  try {
    const stdout = await execGh([
      'api',
      `repos/${owner}/${repo}/secret-scanning/alerts`,
      '--jq', '[.[] | select(.state=="open")]',
    ]);

    if (!stdout || stdout.trim().length === 0) return [];

    const alerts: SecretScanningAlert[] = JSON.parse(stdout);
    return Array.isArray(alerts) ? alerts : [];
  } catch {
    // Secret scanning may not be enabled on this repo
    return [];
  }
}

const scanner: SecurityScanner = {
  id: 'github-audit',
  name: 'GitHub Audit',
  description: 'Audits GitHub repositories for Dependabot vulnerabilities and secret scanning alerts',
  scope: 'weekly',

  async run(context: ScanContext): Promise<ScanResult> {
    const start = Date.now();
    const findings = [];
    const errors: string[] = [];
    const owner = context.githubOwner;

    if (!owner) {
      return {
        findings: [],
        summary: 'GitHub audit skipped: no githubOwner configured',
        durationMs: Date.now() - start,
      };
    }

    let repos: GhRepo[];
    try {
      repos = await listRepos(owner);
    } catch (err) {
      return {
        findings: [],
        summary: `GitHub audit failed: could not list repos - ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    }

    for (const repo of repos) {
      // Dependabot alerts
      try {
        const depAlerts = await getDependabotAlerts(owner, repo.name);
        for (const alert of depAlerts) {
          const severity = mapGitHubSeverity(
            alert.security_vulnerability?.severity ?? alert.security_advisory?.severity
          );
          const pkgName =
            alert.dependency?.package?.name ??
            alert.security_vulnerability?.package?.name ??
            'unknown';
          const advisory = alert.security_advisory?.summary ?? 'No description';
          const cve = alert.security_advisory?.cve_id;

          findings.push(
            createFinding({
              scannerId: 'github-audit',
              severity,
              title: `Dependabot: ${pkgName} vulnerability in ${repo.name}`,
              description: `${advisory}${cve ? ` (${cve})` : ''}`,
              target: `${owner}/${repo.name}`,
              autoFixable: false,
              metadata: {
                alertNumber: alert.number,
                repoName: repo.name,
                repoUrl: repo.url,
                packageName: pkgName,
                cve,
                htmlUrl: alert.html_url,
                manifestPath: alert.dependency?.manifest_path,
                vulnerableRange: alert.security_vulnerability?.vulnerable_version_range,
              },
            })
          );
        }
      } catch (err) {
        errors.push(`${repo.name}/dependabot: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Secret scanning alerts
      try {
        const secretAlerts = await getSecretScanningAlerts(owner, repo.name);
        for (const alert of secretAlerts) {
          findings.push(
            createFinding({
              scannerId: 'github-audit',
              severity: 'critical',
              title: `Secret exposed: ${alert.secret_type_display_name ?? alert.secret_type ?? 'unknown'} in ${repo.name}`,
              description: `GitHub detected an exposed secret in ${owner}/${repo.name}`,
              target: `${owner}/${repo.name}`,
              autoFixable: false,
              metadata: {
                alertNumber: alert.number,
                repoName: repo.name,
                secretType: alert.secret_type,
                secretTypeDisplay: alert.secret_type_display_name,
                htmlUrl: alert.html_url,
                createdAt: alert.created_at,
              },
            })
          );
        }
      } catch (err) {
        errors.push(`${repo.name}/secret-scanning: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const durationMs = Date.now() - start;
    const errorSuffix = errors.length > 0 ? ` (${errors.length} API errors)` : '';

    return {
      findings,
      summary: `GitHub audit complete: ${findings.length} alerts across ${repos.length} repos${errorSuffix}`,
      durationMs,
    };
  },
};

export default scanner;
