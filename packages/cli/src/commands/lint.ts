/**
 * `ico lint` — audit compiled knowledge for schema, staleness, and structural
 * issues.
 *
 * Checks performed (logic lives in `@ico/compiler`):
 *   1. Schema validation — every compiled page in wiki/ validates against its
 *      frontmatter schema.
 *   2. Staleness — any compilation whose source has been re-ingested since the
 *      compilation ran.
 *   3. Uncompiled sources — sources with no summary compilation record.
 *   4. Orphan pages — wiki pages with no incoming [[slug]] backlinks.
 *
 * This file is the CLI surface only — commander wiring + human-readable
 * report rendering. The pure lint logic was extracted to
 * `packages/compiler/src/lint.ts` in E10-B06 so the benchmark suite and
 * future programmatic callers can invoke it without depending on this
 * CLI module.
 *
 * The previous local exports (`runLint`, `scanWikiPages`, `detectOrphans`,
 * `extractWikilinks`, `LintResult`, `SchemaError`) are re-exported here for
 * source compatibility with existing tests/callers that import them via
 * the CLI path.
 *
 * @module commands/lint
 */

import { join, resolve } from 'node:path';

import type { Command } from 'commander';

import {
  detectOrphans,
  extractWikilinks,
  type LintResult,
  runLint,
  scanWikiPages,
  type SchemaError,
} from '@ico/compiler';

import {
  formatError,
  formatHeader,
  formatJSON,
  formatSuccess,
  formatWarning,
} from '../lib/output.js';

// ---------------------------------------------------------------------------
// Source-compatibility re-exports (logic now lives in @ico/compiler)
// ---------------------------------------------------------------------------

export {
  detectOrphans,
  extractWikilinks,
  type LintResult,
  runLint,
  scanWikiPages,
  type SchemaError,
};

// ---------------------------------------------------------------------------
// Human-readable rendering
// ---------------------------------------------------------------------------

/**
 * Render a `LintResult` as a human-readable health report.
 *
 * @param result        - The lint result to render.
 * @param workspaceRoot - Workspace root used to produce relative paths.
 */
export function renderLintReport(result: LintResult, workspaceRoot: string): string {
  const lines: string[] = [];

  lines.push(formatHeader('Knowledge Health Report'));
  lines.push('');

  const schemaStatus =
    result.schema.invalid === 0
      ? formatSuccess(`${result.schema.valid} pages valid`)
      : formatWarning(`${result.schema.invalid} schema violation(s)`);

  const stalenessStatus =
    result.staleness.stale === 0
      ? formatSuccess('all compilations current')
      : formatWarning(`${result.staleness.stale} stale page(s) need recompilation`);

  const uncompiledStatus =
    result.uncompiled.count === 0
      ? formatSuccess('0 uncompiled sources')
      : formatWarning(`${result.uncompiled.count} uncompiled source(s)`);

  const orphanStatus =
    result.orphans.count === 0
      ? formatSuccess('no orphan pages')
      : formatWarning(`${result.orphans.count} page(s) with no backlinks`);

  const pad = (label: string): string => `  ${label.padEnd(16)}`;

  lines.push(`${pad('Schema:')}${schemaStatus}`);
  lines.push(`${pad('Staleness:')}${stalenessStatus}`);
  lines.push(`${pad('Uncompiled:')}${uncompiledStatus}`);
  lines.push(`${pad('Orphans:')}${orphanStatus}`);
  lines.push('');

  if (result.issues === 0) {
    lines.push(formatSuccess('All checks passed'));
  } else {
    lines.push(
      result.issues === 1
        ? formatWarning('1 issue found')
        : formatWarning(`${result.issues} issues found`),
    );
  }

  if (result.schema.errors.length > 0) {
    lines.push('');
    lines.push('  Schema violations:');
    for (const se of result.schema.errors) {
      const relPath = se.path.startsWith(workspaceRoot)
        ? se.path.slice(workspaceRoot.length).replace(/^[\\/]/, '')
        : se.path;
      lines.push(`    ${relPath}`);
      for (const e of se.errors) {
        lines.push(`      ${e}`);
      }
    }
  }

  if (result.staleness.stale > 0) {
    lines.push('');
    lines.push('  Stale pages:');
    for (const sp of result.staleness.pages) {
      lines.push(`    ${sp.outputPath} (${sp.reason})`);
    }
  }

  if (result.uncompiled.count > 0) {
    lines.push('');
    lines.push('  Uncompiled sources:');
    for (const src of result.uncompiled.sources) {
      lines.push(`    ${src.path} (${src.type})`);
    }
  }

  if (result.orphans.count > 0) {
    lines.push('');
    lines.push('  Orphan pages:');
    for (const op of result.orphans.pages) {
      const relPath = op.startsWith(workspaceRoot)
        ? op.slice(workspaceRoot.length).replace(/^[\\/]/, '')
        : op;
      lines.push(`    ${relPath}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register `ico lint` onto the root Commander program.
 *
 * @param program - The root Commander `Command` instance.
 */
export function register(program: Command): void {
  program
    .command('lint')
    .description('Audit compiled knowledge for schema, staleness, and structural issues')
    .addHelpText(
      'after',
      '\nExamples:\n  $ ico lint\n  $ ico lint --json\n  $ ico lint --workspace /path/to/ws',
    )
    .action(() => {
      const globalOpts = program.opts<{ workspace?: string; json?: boolean }>();

      const wsPath = resolve(globalOpts.workspace ?? '.');
      const dbPath = join(wsPath, '.ico', 'state.db');

      let result: LintResult;
      try {
        result = runLint(wsPath, dbPath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(formatError(msg));
        process.exit(1);
      }

      if (globalOpts.json === true) {
        console.log(formatJSON(result));
        return;
      }

      console.log(renderLintReport(result, wsPath));

      if (result.issues > 0) {
        process.exitCode = 1;
      }
    });
}
