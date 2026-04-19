// src/builder/types.ts

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type TechDebtStatus = 'open' | 'in-progress' | 'resolved';

export interface ArchitectureDecision {
  id: string;
  project: string;
  context: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  createdAt: number;
}

export interface TechDebtItem {
  id: string;
  project: string;
  title: string;
  description: string;
  severity: Severity;
  filePath: string | null;
  status: TechDebtStatus;
  createdAt: number;
  resolvedAt: number | null;
}
