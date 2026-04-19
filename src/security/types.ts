// src/security/types.ts
import { randomUUID } from 'node:crypto';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type FindingStatus = 'open' | 'fixed' | 'acknowledged' | 'false-positive';
export type ScanTrigger = 'scheduled' | 'manual';
export type ScanScope = 'daily' | 'weekly';

export interface Finding {
  id: string;
  scannerId: string;
  severity: Severity;
  title: string;
  description: string;
  target: string;
  autoFixable: boolean;
  autoFixed: boolean;
  fixDescription?: string;
  status: FindingStatus;
  firstSeen: number;
  lastSeen: number;
  resolvedAt?: number;
  metadata: Record<string, unknown>;
}

export interface ScanContext {
  projectPaths: string[];
  tailscaleNodes: string[];
  domains: string[];
  githubOwner: string;
  expectedPorts: Record<string, string[]>;
}

export interface ScanResult {
  findings: Finding[];
  summary: string;
  durationMs: number;
}

export interface AutoFixResult {
  findingId: string;
  success: boolean;
  description: string;
}

export interface ScanRecord {
  id: string;
  scannerId: string;
  startedAt: number;
  durationMs: number;
  findingsCount: number;
  trigger: ScanTrigger;
}

export interface ScoreSnapshot {
  date: string;
  score: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
}

export interface SecurityScanner {
  id: string;
  name: string;
  description: string;
  scope: ScanScope;
  run(context: ScanContext): Promise<ScanResult>;
  autoFix?(findings: Finding[]): Promise<AutoFixResult[]>;
}

export function createFinding(
  partial: Omit<Finding, 'id' | 'status' | 'firstSeen' | 'lastSeen' | 'autoFixed'>
): Finding {
  const now = Math.floor(Date.now() / 1000);
  return {
    ...partial,
    id: randomUUID(),
    status: 'open',
    autoFixed: false,
    firstSeen: now,
    lastSeen: now,
  };
}

export function computeScore(findings: Finding[]): number {
  const open = findings.filter(f => f.status === 'open');
  const deductions: Record<Severity, number> = {
    critical: 25, high: 10, medium: 3, low: 1, info: 0,
  };
  const total = open.reduce((sum, f) => sum + (deductions[f.severity] || 0), 0);
  return Math.max(0, 100 - total);
}
