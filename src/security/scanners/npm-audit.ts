// src/security/scanners/npm-audit.ts
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  SecurityScanner,
  ScanContext,
  ScanResult,
  Finding,
  AutoFixResult,
  Severity,
} from '../types.js';
import { createFinding } from '../types.js';

const SCANNER_ID = 'npm-audit';
const AUDIT_TIMEOUT = 30_000;
const FIX_TIMEOUT = 120_000;

/** Map npm severity names to our Severity type. */
function mapSeverity(npmSeverity: string): Severity {
  switch (npmSeverity.toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'moderate':
      return 'medium';
    case 'low':
      return 'low';
    case 'info':
      return 'info';
    default:
      return 'low';
  }
}

/** Run a command via execFile and return stdout. */
function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // npm audit exits non-zero when vulnerabilities are found -- not an error for us
        const exitCode =
          error && 'code' in error ? (error.code as number) : 0;
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode });
      },
    );
  });
}

/** Check whether a file exists. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Discover all directories under projectPaths that contain a package.json (including server/ subdirs). */
async function discoverNpmProjects(projectPaths: string[]): Promise<string[]> {
  const dirs: string[] = [];

  for (const projectPath of projectPaths) {
    // Check the project root
    if (await fileExists(join(projectPath, 'package.json'))) {
      dirs.push(projectPath);
    }

    // Check server/ subdir
    const serverDir = join(projectPath, 'server');
    if (await fileExists(join(serverDir, 'package.json'))) {
      dirs.push(serverDir);
    }
  }

  return dirs;
}

interface NpmAuditVulnerability {
  name: string;
  severity: string;
  via: Array<string | { title?: string; url?: string; source?: number }>;
  effects: string[];
  range: string;
  fixAvailable:
    | boolean
    | { name: string; version: string; isSemVerMajor: boolean };
  isDirect?: boolean;
}

interface NpmAuditOutput {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
  metadata?: {
    vulnerabilities?: Record<string, number>;
  };
}

/** Parse npm audit --json output, returning the vulnerabilities map. */
function parseAuditOutput(stdout: string): NpmAuditOutput | null {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout) as NpmAuditOutput;
  } catch {
    return null;
  }
}

/** Check if a package is listed as a devDependency in the given directory. */
async function isDevDependency(dir: string, pkgName: string): Promise<boolean> {
  try {
    const raw = await readFile(join(dir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as {
      devDependencies?: Record<string, string>;
    };
    return pkgName in (pkg.devDependencies ?? {});
  } catch {
    return false;
  }
}

/** Run npm audit --json in a directory and check if a specific package still has vulnerabilities. */
async function vulnStillPresent(
  dir: string,
  pkgName: string,
): Promise<boolean> {
  const { stdout } = await runCommand(
    'npm',
    ['audit', '--json'],
    dir,
    AUDIT_TIMEOUT,
  );

  const parsed = parseAuditOutput(stdout);
  if (!parsed) return false;

  const vulns = parsed.vulnerabilities ?? {};
  return pkgName in vulns;
}

/** Run npm audit on a single directory and return findings. */
async function auditDir(dir: string): Promise<Finding[]> {
  const { stdout } = await runCommand(
    'npm',
    ['audit', '--json'],
    dir,
    AUDIT_TIMEOUT,
  );

  const parsed = parseAuditOutput(stdout);
  if (!parsed) return [];

  const findings: Finding[] = [];
  const vulns = parsed.vulnerabilities ?? {};

  for (const [pkgName, vuln] of Object.entries(vulns)) {
    // Skip "transitive" entries that are just effects of a direct vuln
    // (they have via entries that are just strings referencing other packages)
    const directVia = (vuln.via ?? []).filter(
      (v): v is { title?: string; url?: string; source?: number } =>
        typeof v !== 'string',
    );

    if (directVia.length === 0) {
      continue;
    }

    const severity = mapSeverity(vuln.severity);
    const title = directVia[0]?.title ?? `Vulnerability in ${pkgName}`;
    const url = directVia[0]?.url ?? '';
    const fixAvailable =
      typeof vuln.fixAvailable === 'object'
        ? vuln.fixAvailable
        : vuln.fixAvailable === true
          ? { name: pkgName, version: 'latest', isSemVerMajor: false }
          : null;

    findings.push(
      createFinding({
        scannerId: SCANNER_ID,
        severity,
        title: `${pkgName}: ${title}`,
        description: url
          ? `Affected range: ${vuln.range}. Details: ${url}`
          : `Affected range: ${vuln.range}`,
        target: dir,
        // Mark all findings with a fix available as auto-fixable -- we handle
        // semver-major cases in the escalation logic inside autoFix()
        autoFixable: fixAvailable !== null,
        metadata: {
          package: pkgName,
          range: vuln.range,
          fixAvailable: vuln.fixAvailable,
          url,
        },
      }),
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Auto-fix with escalation
// ---------------------------------------------------------------------------

interface FixAttemptResult {
  resolved: boolean;
  description: string;
}

/**
 * Try to fix a single package vulnerability using escalating strategies:
 * 1. npm audit fix (safe, non-breaking)
 * 2. npm audit fix --force (only for devDeps or same-major bumps)
 * 3. npm install PACKAGE@latest (direct install of the specific package)
 *
 * After each attempt, re-runs npm audit --json to verify resolution.
 */
async function fixPackage(
  dir: string,
  pkgName: string,
  fixAvailable: NpmAuditVulnerability['fixAvailable'],
): Promise<FixAttemptResult> {
  // ------ Step 1: npm audit fix (safe) ------
  await runCommand('npm', ['audit', 'fix'], dir, FIX_TIMEOUT);

  if (!(await vulnStillPresent(dir, pkgName))) {
    return {
      resolved: true,
      description: `npm audit fix resolved ${pkgName} in ${dir}`,
    };
  }

  // ------ Step 2: npm audit fix --force (guarded) ------
  // Only escalate for dev dependencies or when the fix is within the same major
  const fixInfo =
    typeof fixAvailable === 'object' && fixAvailable !== null
      ? fixAvailable
      : null;

  const isSemVerMajor = fixInfo?.isSemVerMajor ?? false;
  const isDev = await isDevDependency(dir, pkgName);

  // Allow --force if it's a dev dep (breakage is low risk) or the bump is NOT
  // a semver-major change (i.e. same major version).
  if (isDev || !isSemVerMajor) {
    await runCommand('npm', ['audit', 'fix', '--force'], dir, FIX_TIMEOUT);

    if (!(await vulnStillPresent(dir, pkgName))) {
      return {
        resolved: true,
        description: `npm audit fix --force resolved ${pkgName} in ${dir}${isDev ? ' (devDependency)' : ''}`,
      };
    }
  }

  // ------ Step 3: npm install PACKAGE@latest ------
  const targetVersion = fixInfo?.version ?? 'latest';
  const installTarget = `${pkgName}@${targetVersion}`;
  const saveFlag = isDev ? '--save-dev' : '--save';

  const { stderr } = await runCommand(
    'npm',
    ['install', installTarget, saveFlag],
    dir,
    FIX_TIMEOUT,
  );

  if (!(await vulnStillPresent(dir, pkgName))) {
    return {
      resolved: true,
      description: `npm install ${installTarget} resolved ${pkgName} in ${dir}`,
    };
  }

  // ------ All strategies exhausted ------
  const reason = isSemVerMajor && !isDev
    ? `Requires semver-major bump (${fixInfo?.name ?? pkgName} -> ${fixInfo?.version ?? 'unknown'}); manual upgrade and testing needed`
    : `All auto-fix strategies failed for ${pkgName}. stderr: ${stderr.slice(0, 200)}`;

  return { resolved: false, description: reason };
}

const npmAuditScanner: SecurityScanner = {
  id: SCANNER_ID,
  name: 'NPM Audit',
  description:
    'Scans npm projects for known vulnerabilities using npm audit.',
  scope: 'daily',

  async run(context: ScanContext): Promise<ScanResult> {
    const start = Date.now();
    const dirs = await discoverNpmProjects(context.projectPaths);

    if (dirs.length === 0) {
      return {
        findings: [],
        summary: 'No npm projects found to audit.',
        durationMs: Date.now() - start,
      };
    }

    const allFindings: Finding[] = [];
    const errors: string[] = [];

    const results = await Promise.allSettled(dirs.map((d) => auditDir(d)));

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        allFindings.push(...result.value);
      } else {
        errors.push(`${dirs[i]}: ${result.reason}`);
      }
    }

    const durationMs = Date.now() - start;
    const summary =
      `Audited ${dirs.length} npm project(s). ` +
      `Found ${allFindings.length} vulnerability(ies).` +
      (errors.length > 0 ? ` ${errors.length} project(s) errored.` : '');

    return { findings: allFindings, summary, durationMs };
  },

  async autoFix(findings: Finding[]): Promise<AutoFixResult[]> {
    const fixable = findings.filter((f) => f.autoFixable);
    if (fixable.length === 0) return [];

    const results: AutoFixResult[] = [];

    // Process each finding individually so we can verify per-package resolution
    // and use targeted escalation strategies.
    for (const finding of fixable) {
      const dir = finding.target;
      const pkgName = finding.metadata.package as string;
      const fixAvailable =
        finding.metadata.fixAvailable as NpmAuditVulnerability['fixAvailable'];

      const { resolved, description } = await fixPackage(
        dir,
        pkgName,
        fixAvailable,
      );

      if (!resolved) {
        // Mark the finding as not auto-fixable so we don't keep retrying
        finding.autoFixable = false;
        finding.fixDescription = description;
      }

      results.push({
        findingId: finding.id,
        success: resolved,
        description,
      });
    }

    return results;
  },
};

export default npmAuditScanner;
