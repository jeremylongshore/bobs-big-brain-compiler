import { defineConfig } from 'vitest/config';

/**
 * Root Vitest configuration for the intentional-cognition-os monorepo.
 *
 * Used by `pnpm test:coverage` to collect unified cross-package coverage.
 * Individual package `pnpm test` commands continue to run per-package via
 * `pnpm -r test` and do not require this file.
 *
 * Coverage thresholds enforce minimum coverage per package.
 * Raise thresholds as packages mature.
 */
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['evals/**', '**/dist/**', '**/node_modules/**'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/dist/**', '**/node_modules/**'],
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        // Engineer-owned floors. Policy lives in tests/TESTING.md; this file
        // mirrors those values. Lowering any floor is policy and must be paired
        // with `scripts/audit-harness init` (caught by escape-scan otherwise).
        'packages/types/src': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
        'packages/kernel/src': {
          statements: 80,
          branches: 70,
          functions: 80,
          lines: 80,
        },
        // Initial floors at current measured value − 2% to halt regression
        // while the climb is sequenced. Bump as the suite matures.
        'packages/compiler/src': {
          statements: 60,
          branches: 55,
          functions: 60,
          lines: 60,
        },
        'packages/cli/src': {
          statements: 43,
          branches: 40,
          functions: 43,
          lines: 43,
        },
        // Benchmarks workspace: coverage isn't a meaningful metric for a
        // scenario-runner harness; thresholds intentionally omitted (waived
        // per tests/TESTING.md).
      },
    },
  },
});
