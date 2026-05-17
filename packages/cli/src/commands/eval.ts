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

import { createClaudeClient, runCompilationEval } from '@ico/compiler';
import {
  closeDatabase,
  type EvalBatchResult,
  type EvalResult,
  type EvalSpec,
  initDatabase,
  loadAllEvalSpecs,
  loadConfig,
  loadEvalSpec,
  runEval,
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

export async function runEvalCommand(
  opts: RunOpts,
  globalOpts: GlobalOptions,
): Promise<
  | { ok: true; value: { batch: EvalBatchResult; loadErrors: Array<{ path: string; error: Error }> } }
  | { ok: false; error: Error }
> {
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

    // Dispatch each spec by type. Smoke + retrieval go through the kernel
    // runner; compilation goes through @ico/compiler because it needs a
    // ClaudeClient. We only initialize the Claude client lazily — when at
    // least one compilation spec is present — so the CLI stays usable
    // without an API key for smoke/retrieval-only suites.
    const batchStart = Date.now();
    const results: EvalResult[] = [];

    let claudeClient: ReturnType<typeof createClaudeClient> | null = null;
    let defaultModel: string | undefined;
    const needsClaude = specs.some((s) => s.type === 'compilation');
    if (needsClaude) {
      let config: { apiKey: string; model: string };
      try {
        config = loadConfig(wsPath);
      } catch (e) {
        return {
          ok: false,
          error: new Error(
            `Compilation evals need a Claude key. Config load failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
        };
      }
      claudeClient = createClaudeClient(config.apiKey);
      // Honor the workspace's configured model as the fallback. The
      // handler's precedence is: spec.model > options.model > env > hard
      // default. By passing config.model in options, the operator's
      // workspace setting wins over env and default but a per-spec
      // override still takes precedence.
      defaultModel = config.model;
    }

    for (const spec of specs) {
      const correlationId = randomUUID();
      let result: EvalResult;
      if (spec.type === 'compilation') {
        // claudeClient is non-null here because we built it above when
        // any compilation spec was present.
        const r = await runCompilationEval(db, wsPath, spec, claudeClient!, {
          correlationId,
          // spec.model wins inside the handler when set; options.model
          // is the workspace-config fallback.
          ...(spec.model === undefined && defaultModel !== undefined
            ? { model: defaultModel }
            : {}),
        });
        result = r.ok
          ? r.value
          : {
              spec,
              passed: false,
              score: 0,
              threshold: spec.threshold ?? 1,
              details: `Handler crashed: ${r.error.message}`,
              durationMs: 0,
            };
      } else {
        const r = runEval(db, wsPath, spec, { correlationId });
        result = r.ok
          ? r.value
          : {
              spec,
              passed: false,
              score: 0,
              threshold: spec.threshold ?? 1,
              details: `Handler crashed: ${r.error.message}`,
              durationMs: 0,
            };
      }
      results.push(result);
    }

    const passed = results.filter((r) => r.passed).length;
    const batch: EvalBatchResult = {
      total: results.length,
      passed,
      failed: results.length - passed,
      results,
      durationMs: Date.now() - batchStart,
    };

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
    .action(async (opts: RunOpts, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals<GlobalOptions>();
      const global: GlobalOptions = {
        ...(globalOpts.json !== undefined && { json: globalOpts.json }),
        ...(globalOpts.verbose !== undefined && { verbose: globalOpts.verbose }),
        ...(globalOpts.workspace !== undefined && { workspace: globalOpts.workspace }),
      };
      const result = await runEvalCommand(opts, global);
      if (!result.ok) {
        process.stderr.write(formatError(result.error.message) + '\n');
        process.exit(1);
      }
      if (result.value.batch.failed > 0 || result.value.batch.total === 0) {
        process.exit(1);
      }
    });
}
