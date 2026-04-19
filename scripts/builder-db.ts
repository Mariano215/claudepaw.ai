#!/usr/bin/env tsx
// scripts/builder-db.ts -- CLI for Builder persistence (called by Builder soul via Bash)

import { initDatabase } from '../src/db.js';
import { createBuilderTables, logDecision, getDecisions, addTechDebt, getTechDebt, resolveTechDebt } from '../src/builder/persistence.js';
import type { Severity } from '../src/builder/types.js';

// Init DB + tables
initDatabase();
createBuilderTables();

const [command, ...rest] = process.argv.slice(2);

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '';
      result[key] = value;
      if (value) i++;
    }
  }
  return result;
}

const args = parseArgs(rest);

switch (command) {
  case 'log-decision': {
    const { project, context, decision, rationale, alternatives } = args;
    if (!project || !context || !decision || !rationale) {
      console.error('Usage: builder-db.ts log-decision --project X --context X --decision X --rationale X [--alternatives "a,b,c"]');
      process.exit(1);
    }
    const alts = alternatives ? alternatives.split(',').map(s => s.trim()) : [];
    const id = logDecision(project, context, decision, rationale, alts);
    console.log(`Decision logged: ${id}`);
    break;
  }

  case 'get-decisions': {
    const { project, limit } = args;
    const decisions = getDecisions(project || undefined, limit ? parseInt(limit) : undefined);
    if (decisions.length === 0) {
      console.log('No architecture decisions found.');
    } else {
      for (const d of decisions) {
        const date = new Date(d.createdAt * 1000).toISOString().slice(0, 10);
        console.log(`[${date}] ${d.project}: ${d.decision}`);
        console.log(`  Context: ${d.context}`);
        console.log(`  Rationale: ${d.rationale}`);
        if (d.alternatives.length > 0) console.log(`  Alternatives: ${d.alternatives.join(', ')}`);
        console.log();
      }
    }
    break;
  }

  case 'add-debt': {
    const { project, title, description, severity, file } = args;
    if (!project || !title || !severity) {
      console.error('Usage: builder-db.ts add-debt --project X --title X --severity critical|high|medium|low [--description X] [--file X]');
      process.exit(1);
    }
    if (!['critical', 'high', 'medium', 'low'].includes(severity)) {
      console.error(`Invalid severity: ${severity}. Must be critical|high|medium|low`);
      process.exit(1);
    }
    const id = addTechDebt(project, title, description || '', severity as Severity, file || undefined);
    console.log(`Tech debt added: ${id}`);
    break;
  }

  case 'get-debt': {
    const { project, status } = args;
    const items = getTechDebt(project || undefined, (status as any) || undefined);
    if (items.length === 0) {
      console.log('No tech debt found.');
    } else {
      for (const d of items) {
        const date = new Date(d.createdAt * 1000).toISOString().slice(0, 10);
        const fileInfo = d.filePath ? ` (${d.filePath})` : '';
        console.log(`[${d.severity.toUpperCase()}] ${d.project}: ${d.title}${fileInfo}`);
        console.log(`  Status: ${d.status} | Added: ${date} | ID: ${d.id}`);
        if (d.description) console.log(`  ${d.description}`);
        console.log();
      }
    }
    break;
  }

  case 'resolve-debt': {
    const { id } = args;
    if (!id) {
      console.error('Usage: builder-db.ts resolve-debt --id <uuid>');
      process.exit(1);
    }
    resolveTechDebt(id);
    console.log(`Tech debt resolved: ${id}`);
    break;
  }

  default:
    console.log(`ClaudePaw Builder DB CLI

Commands:
  log-decision  --project X --context X --decision X --rationale X [--alternatives "a,b,c"]
  get-decisions  [--project X] [--limit N]
  add-debt       --project X --title X --severity critical|high|medium|low [--description X] [--file X]
  get-debt       [--project X] [--status open|in-progress|resolved]
  resolve-debt   --id <uuid>
`);
    if (command) process.exit(1);
}
