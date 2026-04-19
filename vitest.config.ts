import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['src/**/*.test.ts', 'node_modules', 'dist', 'server', 'guard-sidecar'],
      // Global floors calibrated to actual coverage. Lifted 2026-04-14 after
      // adding tests for webhooks, security (registry/persistence/auto-fix),
      // plugins registry, and newsletter hero. Floors sit ~3 points under
      // actual to leave headroom for incidental dips.
      //
      // Per-module floors lock in the high-value modules so a regression in
      // one cannot be averaged away by coverage gains elsewhere. The globs use
      // vitest's threshold-per-path syntax (v8 provider).
      //
      // Security scanners/* (4% -- CLI wrappers around subprocess audit tools)
      // and newsletter hero.ts sharp-optimization path remain deliberately
      // uncovered and drag the aggregates down.
      thresholds: {
        statements: 48,
        branches: 40,
        functions: 52,
        lines: 48,
        // Webhooks: real DB tests and HMAC/delivery paths are covered.
        // Aggregate actuals at Round 4: stmts 97.33, br 90.47, fn 100, lines 98.57.
        // Floors set to catch regressions with a few points of headroom.
        'src/webhooks/**/*.ts': {
          statements: 90,
          branches: 85,
          functions: 95,
          lines: 90,
        },
        // Security registry/persistence/auto-fix. The scanners subdir is
        // out of scope (CLI wrappers) and index.ts/reporter.ts are not yet
        // covered -- when added, raise these floors.
        'src/security/registry.ts': {
          statements: 95,
          branches: 85,
          functions: 95,
          lines: 95,
        },
        'src/security/persistence.ts': {
          statements: 85,
          branches: 75,
          functions: 85,
          lines: 85,
        },
        'src/security/auto-fix.ts': {
          statements: 95,
          branches: 85,
          functions: 95,
          lines: 95,
        },
        'src/plugins/registry.ts': {
          statements: 95,
          branches: 85,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
});
