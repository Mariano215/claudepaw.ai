// src/builder/index.ts
import { logger } from '../logger.js';
import { createBuilderTables } from './persistence.js';

export {
  logDecision,
  getDecisions,
  addTechDebt,
  getTechDebt,
  resolveTechDebt,
  updateTechDebtStatus,
} from './persistence.js';

export type {
  ArchitectureDecision,
  TechDebtItem,
  Severity,
  TechDebtStatus,
} from './types.js';

export function initBuilder(): void {
  createBuilderTables();
  logger.info('Builder memory system initialized');
}
