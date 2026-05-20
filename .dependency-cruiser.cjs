/**
 * Dependency-cruiser config for intentional-cognition-os.
 *
 * Encodes the layered topology from CLAUDE.md:
 *   types → kernel → compiler → cli
 *
 * A lower layer must never depend on a higher layer.
 * `benchmarks` may consume cli + compiler (it drives them) but is itself a leaf.
 *
 * Engineer-owned: this file is hash-pinned via `scripts/audit-harness init`.
 * Any AI-proposed edit will be REFUSED by escape-scan unless re-initialized
 * by the engineer.
 */
module.exports = {
  forbidden: [
    {
      name: 'types-no-upward-deps',
      severity: 'error',
      comment: '@ico/types must not depend on any other workspace package.',
      from: { path: '^packages/types/src' },
      to: { path: '^packages/(kernel|compiler|cli|benchmarks)/' },
    },
    {
      name: 'kernel-no-upward-deps',
      severity: 'error',
      comment: '@ico/kernel may depend on @ico/types only.',
      from: { path: '^packages/kernel/src' },
      to: { path: '^packages/(compiler|cli|benchmarks)/' },
    },
    {
      name: 'compiler-no-cli-or-bench',
      severity: 'error',
      comment: '@ico/compiler may depend on @ico/types and @ico/kernel only.',
      from: { path: '^packages/compiler/src' },
      to: { path: '^packages/(cli|benchmarks)/' },
    },
    {
      name: 'cli-no-benchmarks',
      severity: 'error',
      comment: 'CLI must not depend on @ico/benchmarks (benchmarks is a downstream consumer).',
      from: { path: '^packages/cli/src' },
      to: { path: '^packages/benchmarks/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are forbidden.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphan modules (no incoming references) are likely dead code.',
      from: {
        orphan: true,
        pathNot: [
          '\\.(test|spec|d)\\.ts$',
          '(^|/)index\\.ts$',
          '/src/(commands|api|cli)/',
          'packages/[^/]+/src/index\\.ts$',
          // Tooling entrypoints — invoked by vitest / tsup, not imported.
          'packages/[^/]+/(vitest|tsup|stryker)\\.config\\.ts$',
          // Eval schema modules — consumed via dynamic YAML dispatch.
          'packages/[^/]+/src/evals/types\\.ts$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(^|/)(node_modules|dist|coverage|\\.arch|\\.stryker-tmp|reports)(/|$)',
    },
    includeOnly: '^packages/',
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      dot: {
        collapsePattern: 'node_modules/[^/]+',
      },
      archi: {
        collapsePattern: '^packages/[^/]+/src',
      },
    },
  },
};
