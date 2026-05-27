// Stryker config — ESM module form. Filename `stryker.config.js` is in the
// audit-harness PATTERNS list so this file is hash-pinned via `audit-harness
// init` (bead 0wy.2). The repo is `"type": "module"` (ESM), so `.js` is
// parsed as ESM; `export default { ... }` is the correct form.
//
// Stryker config scoped to kernel (deterministic state-machine surface —
// highest mutation-test signal). Compiler scope deferred to a follow-up
// bead: compiler talks to Claude through ClaudeClient which is mocked in
// tests, so mutation score there reflects mock-coverage not real behavior.
// See bead 0wy.1 closing notes + tests/TESTING.md.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  packageManager: 'pnpm',
  testRunner: 'vitest',
  // Explicit plugins entry: pnpm's symlink layout breaks Stryker's default
  // '@stryker-mutator/*' plugin glob.
  plugins: ['@stryker-mutator/vitest-runner'],
  coverageAnalysis: 'perTest',
  // Static mutants (string constants, etc.) are 10% of mutants but 60% of
  // runtime in this codebase. CI feasibility requires ignoring them. They
  // have low kill-signal anyway — surviving a static mutant only means no
  // test ran the file at all.
  ignoreStatic: true,
  mutate: [
    'packages/kernel/src/**/*.ts',
    '!packages/kernel/src/**/*.test.ts',
    '!packages/kernel/src/**/__tests__/**',
    '!packages/kernel/src/**/*.d.ts',
  ],
  // Stryker invokes vitest at the package root (packages/kernel) not the
  // monorepo root — vitest configs use cwd-relative include patterns
  // (src/**/*.test.ts).
  vitest: {
    configFile: 'packages/kernel/vitest.config.ts',
    dir: 'packages/kernel',
  },
  thresholds: {
    high: 80,
    low: 60,
    // Baseline measured 2026-05-25: 60.25% total kill rate (1800/2989
    // mutants, 11:36 wall-clock, ignoreStatic=true). Floor = baseline - 5
    // = 55. PRs that drop below this fail the mutation-test job.
    break: 55,
  },
  concurrency: 4,
  timeoutMS: 30000,
  reporters: ['progress', 'clear-text', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
};
