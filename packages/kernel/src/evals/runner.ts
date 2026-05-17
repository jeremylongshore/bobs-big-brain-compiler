/**
 * Eval batch runner (E10-B01).
 *
 * Public entry point for executing one or more eval specs. Dispatches
 * each spec to the matching handler, emits `eval.run` and `eval.result`
 * traces (011-AT-TRSC §6.17–6.18), and aggregates outcomes into a
 * batch summary.
 *
 * Tracing contract: every spec emits exactly two events sharing the
 * same `correlation_id` (a fresh UUID per spec). Batch-level
 * correlation is left to the caller — the CLI generates its own
 * batch-id and passes it via the `batchCorrelationId` option when it
 * wants the events grouped across the whole `ico eval run`.
 */

import { randomUUID } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';

import { writeTrace } from '../traces.js';
import { runRetrievalEval } from './handlers/retrieval.js';
import { runSmokeEval } from './handlers/smoke.js';
import type { EvalBatchResult, EvalResult, EvalSpec } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunEvalOptions {
  /**
   * When provided, used as `correlation_id` on both the eval.run and
   * eval.result events so the whole batch is groupable in the trace
   * file. Defaults to a fresh UUID per spec.
   */
  correlationId?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a single eval spec end-to-end:
 *
 *   1. Emit `eval.run` trace.
 *   2. Dispatch to the matching handler.
 *   3. Emit `eval.result` trace with passed/score/details/duration.
 *
 * Returns the {@link EvalResult} on success. A handler-level err()
 * propagates as the runner's err — the eval.run trace is still emitted
 * but no eval.result is, so a missing eval.result is itself a forensic
 * signal that the spec crashed.
 */
export function runEval(
  db: Database,
  workspacePath: string,
  spec: EvalSpec,
  options: RunEvalOptions = {},
): Result<EvalResult, Error> {
  const correlationId = options.correlationId ?? randomUUID();

  const startTrace = writeTrace(
    db,
    workspacePath,
    'eval.run',
    {
      eval_id: spec.id,
      eval_name: spec.name,
      target: spec.target ?? spec.type,
    },
    { correlationId },
  );
  if (!startTrace.ok) return err(startTrace.error);

  let outcome: Result<EvalResult, Error>;
  switch (spec.type) {
    case 'retrieval':
      outcome = runRetrievalEval(db, spec);
      break;
    case 'smoke':
      outcome = runSmokeEval(db, workspacePath, spec);
      break;
    case 'compilation':
      // Compilation evals require a ClaudeClient which lives in
      // @ico/compiler. The kernel cannot import the compiler (compiler
      // depends on kernel). Compilation specs are routed through the
      // compiler-side runner; calling them on the kernel runner is a
      // configuration error.
      outcome = err(
        new Error(
          `Compilation eval '${spec.id}' must be dispatched through @ico/compiler's runCompilationEval — not the kernel runner.`,
        ),
      );
      break;
  }
  if (!outcome.ok) return err(outcome.error);
  const result = outcome.value;

  const endTrace = writeTrace(
    db,
    workspacePath,
    'eval.result',
    {
      eval_id: spec.id,
      eval_name: spec.name,
      passed: result.passed,
      score: result.score,
      details: result.details,
      duration_ms: result.durationMs,
    },
    { correlationId },
  );
  if (!endTrace.ok) return err(endTrace.error);

  return ok(result);
}

/**
 * Run a batch of specs in order. A failing spec does NOT abort the
 * batch — every spec runs and its outcome is collected. A handler-level
 * crash (err result) is treated as a failed eval with score 0 and the
 * error message as details, so the batch summary is always complete.
 */
export function runEvals(
  db: Database,
  workspacePath: string,
  specs: ReadonlyArray<EvalSpec>,
): Result<EvalBatchResult, Error> {
  const results: EvalResult[] = [];
  const batchStart = Date.now();

  for (const spec of specs) {
    const r = runEval(db, workspacePath, spec);
    if (r.ok) {
      results.push(r.value);
    } else {
      results.push({
        spec,
        passed: false,
        score: 0,
        threshold: spec.threshold ?? 1,
        details: `Handler crashed: ${r.error.message}`,
        durationMs: 0,
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  return ok({
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
    durationMs: Date.now() - batchStart,
  });
}
