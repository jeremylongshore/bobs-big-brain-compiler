/**
 * `ico eval run [--spec <path>]` — discover and execute eval specs (E10-B01).
 *
 * Behaviour:
 *   - No `--spec`: walks the workspace `evals/` tree, loads every
 *     `*.eval.yaml` / `*.eval.yml`, and runs them in alphabetical order.
 *     Bad specs are reported but do not abort the batch.
 *   - `--spec <path>`: runs a single spec at the given file path
 *     (resolved relative to the workspace root if not absolute).
 *
 * Exit codes:
 *   - 0 when every spec passed
 *   - 1 when one or more specs failed (or no specs were found, since a
 *     workspace with zero evals is not "passing" — surface the gap loudly)
 *
 * @module commands/eval
 */

import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';

import type { Command } from 'commander';

import {
  closeDatabase,
  type EvalBatchResult,
  type EvalResult,
  type EvalSpec,
  initDatabase,
  loadAllEvalSpecs,
  loadEvalSpec,
  runEval,
  runEvals,
} from '@ico/kernel';

import {
  dim,
  formatError,
  formatHeader,
  formatInfo,
  formatJSON,
  formatSuccess,
  formatWarning,
} from '../lib/output.js';
import { resolveWorkspace } from '../lib/workspace-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
  workspace?: string;
}

interface RunOpts {
  spec?: string;
}

// ---------------------------------------------------------------------------
// Core (exported for tests)
// ---------------------------------------------------------------------------

export function runEvalCommand(
  opts: RunOpts,
  globalOpts: GlobalOptions,
):
  | { ok: true; value: { batch: EvalBatchResult; loadErrors: Array<{ path: string; error: Error }> } }
  | { ok: false; error: Error } {
  const wsResolveOpts =
    globalOpts.workspace !== undefined ? { workspace: globalOpts.workspace } : {};
  const wsResult = resolveWorkspace(wsResolveOpts);
  if (!wsResult.ok) return { ok: false, error: wsResult.error };
  const { root: wsPath, dbPath } = wsResult.value;

  const dbResult = initDatabase(dbPath);
  if (!dbResult.ok) return { ok: false, error: dbResult.error };
  const db = dbResult.value;

  try {
    const loadErrors: Array<{ path: string; error: Error }> = [];
    const specs: EvalSpec[] = [];

    if (opts.spec !== undefined) {
      const abs = resolvePath(wsPath, opts.spec);
      const single = loadEvalSpec(abs);
      if (!single.ok) return { ok: false, error: single.error };
      specs.push(single.value);
    } else {
      const evalsDir = resolvePath(wsPath, 'evals');
      const loaded = loadAllEvalSpecs(evalsDir);
      if (!loaded.ok) return { ok: false, error: loaded.error };
      for (const entry of loaded.value) {
        if (entry.spec.ok) {
          specs.push(entry.spec.value);
        } else {
          loadErrors.push({ path: entry.path, error: entry.spec.error });
        }
      }
    }

    let batch: EvalBatchResult;
    if (specs.length === 0) {
      batch = { total: 0, passed: 0, failed: 0, results: [], durationMs: 0 };
    } else if (specs.length === 1) {
      // Single-spec path also goes through runEval so the trace
      // correlation matches what runEvals would emit. Wrap into a
      // singleton batch.
      const correlationId = randomUUID();
      const start = Date.now();
      const r = runEval(db, wsPath, specs[0]!, { correlationId });
      const single: EvalResult = r.ok
        ? r.value
        : {
            spec: specs[0]!,
            passed: false,
            score: 0,
            threshold: specs[0]!.threshold ?? 1,
            details: `Handler crashed: ${r.error.message}`,
            durationMs: 0,
          };
      batch = {
        total: 1,
        passed: single.passed ? 1 : 0,
        failed: single.passed ? 0 : 1,
        results: [single],
        durationMs: Date.now() - start,
      };
    } else {
      const result = runEvals(db, wsPath, specs);
      if (!result.ok) return { ok: false, error: result.error };
      batch = result.value;
    }

    if (globalOpts.json === true) {
      process.stdout.write(formatJSON({ batch, loadErrors }) + '\n');
    } else {
      printBatchReport(batch, loadErrors);
    }
    return { ok: true, value: { batch, loadErrors } };
  } finally {
    closeDatabase(db);
  }
}

function printBatchReport(
  batch: EvalBatchResult,
  loadErrors: ReadonlyArray<{ path: string; error: Error }>,
): void {
  process.stdout.write('\n');
  process.stdout.write(formatHeader('Eval Run') + '\n\n');

  if (loadErrors.length > 0) {
    process.stdout.write(formatWarning(`  ${loadErrors.length} spec(s) failed to load:`) + '\n');
    for (const e of loadErrors) {
      process.stdout.write(`    ${e.path}: ${e.error.message}\n`);
    }
    process.stdout.write('\n');
  }

  if (batch.total === 0) {
    process.stdout.write(
      dim('  No eval specs found. Create one under `evals/*.eval.yaml`.') + '\n\n',
    );
    return;
  }

  for (const r of batch.results) {
    const marker = r.passed ? formatSuccess('✓') : formatWarning('✗');
    const score = `${(r.score * 100).toFixed(0).padStart(3)}%`;
    process.stdout.write(
      `  ${marker}  [${score}]  ${r.spec.id.padEnd(40)}  ${dim(r.details)}\n`,
    );
  }
  process.stdout.write('\n');
  process.stdout.write(
    formatInfo(
      `  Summary: ${batch.passed}/${batch.total} passed  (${batch.durationMs} ms)`,
    ) + '\n',
  );
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function register(program: Command): void {
  const evalCmd = program.command('eval').description('Run evaluation specs (Epic 10)');

  evalCmd
    .command('run')
    .description('Discover and execute every eval spec under `evals/`')
    .option('--spec <path>', 'Run only the spec at this workspace-relative path')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  $ ico eval run',
        '  $ ico eval run --spec evals/smoke/fts5-index-populated.eval.yaml',
        '  $ ico eval run --json',
      ].join('\n'),
    )
    .action((opts: RunOpts, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<GlobalOptions>();
      const global: GlobalOptions = {
        ...(globalOpts.json !== undefined && { json: globalOpts.json }),
        ...(globalOpts.verbose !== undefined && { verbose: globalOpts.verbose }),
        ...(globalOpts.workspace !== undefined && { workspace: globalOpts.workspace }),
      };
      const result = runEvalCommand(opts, global);
      if (!result.ok) {
        process.stderr.write(formatError(result.error.message) + '\n');
        process.exit(1);
      }
      if (result.value.batch.failed > 0 || result.value.batch.total === 0) {
        process.exit(1);
      }
    });
}
