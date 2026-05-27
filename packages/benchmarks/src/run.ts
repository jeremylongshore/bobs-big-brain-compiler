/**
 * Benchmark runner entry point (E10-B06).
 *
 * Executes every scenario, prints a summary, and writes a JSON record
 * under `results/` keyed by ISO-8601 date + git short SHA. The JSON is
 * the durable artefact — checked in as needed for trend analysis,
 * never edited by hand.
 *
 * Run from repo root: `pnpm bench`
 *
 * Subsequent E10-B06 PRs will add compile/ask/render scenarios (Claude-
 * gated) and the large-corpus (500-source) run + 3x-degradation gate.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runAskScenario } from './scenarios/ask.bench.js';
import { runCompileScenario } from './scenarios/compile.bench.js';
import { runIngestScenario } from './scenarios/ingest.bench.js';
import { runLintScenario } from './scenarios/lint.bench.js';
import { runRenderScenario } from './scenarios/render.bench.js';
import {
  computeDegradation,
  type DegradationCheck,
  formatDegradation,
} from './utils/degradation.js';
import { formatBenchResult } from './utils/timer.js';

/** Best-effort git short SHA. Returns 'unknown' when git is unavailable. */
function gitShortSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Common timing payload extracted from a BenchResult. */
interface CommonTiming {
  medianMs: number;
  minMs: number;
  maxMs: number;
  rssDeltaMb: number;
  iterations: number;
  samplesMs: readonly number[];
}

/** A single scenario's record in the JSON output. */
interface ScenarioRecord extends Partial<CommonTiming> {
  name: string;
  /** Free-form per-scenario context (counts, configs). */
  context: Record<string, number | string | boolean>;
  /** Batch wall time when the scenario timed many items (e.g. ingest). */
  batchTotalMs?: number;
  /** True when a Claude-gated scenario was skipped (no key / no opt-in). */
  skipped?: boolean;
  /** Human-readable explanation when `skipped` is true. */
  skipReason?: string;
}

interface RunRecord {
  startedAt: string;
  gitSha: string;
  node: string;
  platform: NodeJS.Platform;
  scenarios: ScenarioRecord[];
  /**
   * Per-scenario degradation checks (3× cap on per-unit cost when
   * comparing moderate vs large corpus). Only populated when
   * `ICO_BENCH_LARGE_CORPUS=1` was set for the run.
   */
  degradationChecks?: DegradationCheck[];
}

/** Outcome shape every gated scenario returns. */
type GatedOutcome =
  | { ran: false; skipReason: string }
  | { ran: true; result: import('./utils/timer.js').BenchResult };

/**
 * Build a ScenarioRecord from a BenchResult + context. Used for the
 * non-gated scenarios (ingest, lint) which always produce a real
 * timing rather than a skip outcome. Gated scenarios go through
 * `recordGatedScenario` instead.
 */
function buildScenarioRecord(
  name: string,
  bench: import('./utils/timer.js').BenchResult,
  context: Record<string, number | string | boolean>,
  extras: { batchTotalMs?: number } = {},
): ScenarioRecord {
  return {
    name,
    medianMs: bench.medianMs,
    minMs: bench.minMs,
    maxMs: bench.maxMs,
    rssDeltaMb: bench.rssDeltaMb,
    iterations: bench.samplesMs.length,
    samplesMs: bench.samplesMs,
    context,
    ...(extras.batchTotalMs !== undefined && { batchTotalMs: extras.batchTotalMs }),
  };
}

/**
 * Format-and-record one ungated scenario. Centralises the print → blank
 * line → record.scenarios.push dance that was duplicated four times
 * (moderate ingest, moderate lint, large ingest, large lint) before
 * bead `wie`. Callers normalise their bench shape at the call site:
 * ingest scenarios pass `ingest.perFile`, lint scenarios pass
 * `lint.result` — both are `BenchResult` instances.
 */
function reportAndRecordScenario(
  record: RunRecord,
  name: string,
  bench: import('./utils/timer.js').BenchResult,
  context: Record<string, number | string | boolean>,
  options: { summaryLine: string; batchTotalMs?: number },
): void {
  console.log(formatBenchResult(bench));
  console.log(options.summaryLine);
  console.log('');
  record.scenarios.push(
    buildScenarioRecord(
      name,
      bench,
      context,
      options.batchTotalMs !== undefined ? { batchTotalMs: options.batchTotalMs } : {},
    ),
  );
}

/**
 * Format + record a Claude-gated scenario. Logs the appropriate
 * one-liner (SKIPPED or formatted bench result) and pushes a
 * ScenarioRecord onto the run record. Centralised here so the
 * upcoming compile + ask scenarios don't duplicate this dance.
 */
function recordGatedScenario(
  name: string,
  context: Record<string, number | string | boolean>,
  outcome: GatedOutcome,
  record: RunRecord,
): void {
  if (!outcome.ran) {
    console.log(`${name}: SKIPPED (${outcome.skipReason})`);
    console.log('');
    record.scenarios.push({
      name,
      context,
      skipped: true,
      skipReason: outcome.skipReason,
    });
    return;
  }
  console.log(formatBenchResult(outcome.result));
  console.log(
    `  context: ${Object.entries(context)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ')}`,
  );
  console.log('');
  record.scenarios.push(buildScenarioRecord(name, outcome.result, context));
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const gitSha = gitShortSha();

  console.log('');
  console.log('=== ICO benchmark run ===');
  console.log(`startedAt:  ${startedAt}`);
  console.log(`gitSha:     ${gitSha}`);
  console.log(`node:       ${process.version}`);
  console.log(`platform:   ${process.platform}`);
  console.log('');

  const record: RunRecord = {
    startedAt,
    gitSha,
    node: process.version,
    platform: process.platform,
    scenarios: [],
  };

  // ---- ingest -----------------------------------------------------------
  const ingest = await runIngestScenario();
  reportAndRecordScenario(
    record,
    'ingest',
    ingest.perFile,
    { sourceCount: ingest.sourceCount, scale: 'moderate' },
    {
      summaryLine: `  batchTotal=${ingest.batchTotalMs.toFixed(0)}ms over ${ingest.sourceCount} sources`,
      batchTotalMs: ingest.batchTotalMs,
    },
  );

  // ---- lint -------------------------------------------------------------
  const lint = await runLintScenario();
  reportAndRecordScenario(
    record,
    'lint',
    lint.result,
    {
      sourceCount: lint.sourceCount,
      conceptCount: lint.conceptCount,
      topicCount: lint.topicCount,
      scale: 'moderate',
    },
    {
      summaryLine: `  context: ${lint.sourceCount} sources, ${lint.conceptCount} concepts, ${lint.topicCount} topics`,
    },
  );

  // ---- compile (Claude-gated) ------------------------------------------
  const compile = await runCompileScenario();
  recordGatedScenario(
    'compile',
    {
      sourceCount: compile.sourceCount,
      ...(compile.perPhaseMs !== undefined && {
        summarizeMedianMs: compile.perPhaseMs.summarize.medianMs,
        extractMedianMs: compile.perPhaseMs.extract.medianMs,
        synthesizeMedianMs: compile.perPhaseMs.synthesize.medianMs,
      }),
    },
    compile.ran
      ? { ran: true, result: compile.result! }
      : { ran: false, skipReason: compile.skipReason ?? 'unknown' },
    record,
  );

  // ---- ask (Claude-gated) ----------------------------------------------
  const ask = await runAskScenario();
  recordGatedScenario(
    'ask',
    {
      conceptCount: ask.conceptCount,
      topicCount: ask.topicCount,
      ...(ask.relevantPageCount !== undefined && { relevantPageCount: ask.relevantPageCount }),
    },
    ask.ran
      ? { ran: true, result: ask.result! }
      : { ran: false, skipReason: ask.skipReason ?? 'unknown' },
    record,
  );

  // ---- render (Claude-gated) -------------------------------------------
  const render = await runRenderScenario();
  recordGatedScenario(
    'render',
    { conceptCount: render.conceptCount },
    render.ran
      ? { ran: true, result: render.result! }
      : { ran: false, skipReason: render.skipReason ?? 'unknown' },
    record,
  );

  // ---- large-corpus (opt-in via ICO_BENCH_LARGE_CORPUS=1) --------------
  // Skipped by default — the 500-source ingest pass takes minutes, not
  // seconds, and only matters when we're validating the 3× degradation
  // gate. Claude-gated scenarios (compile/ask/render) are intentionally
  // NOT included in the large run because the spend implications are
  // material; opt those in separately when ready.
  if (process.env['ICO_BENCH_LARGE_CORPUS'] === '1') {
    console.log('=== Large-corpus run (500 sources) ===');
    console.log('');

    const ingestLarge = await runIngestScenario({ sourceCount: 500 });
    reportAndRecordScenario(
      record,
      'ingest',
      ingestLarge.perFile,
      { sourceCount: ingestLarge.sourceCount, scale: 'large' },
      {
        summaryLine: `  batchTotal=${ingestLarge.batchTotalMs.toFixed(0)}ms over ${ingestLarge.sourceCount} sources`,
        batchTotalMs: ingestLarge.batchTotalMs,
      },
    );

    const lintLarge = await runLintScenario({
      sourceCount: 500,
      conceptCount: 250,
      topicCount: 50,
    });
    reportAndRecordScenario(
      record,
      'lint',
      lintLarge.result,
      {
        sourceCount: lintLarge.sourceCount,
        conceptCount: lintLarge.conceptCount,
        topicCount: lintLarge.topicCount,
        scale: 'large',
      },
      {
        summaryLine: `  context: ${lintLarge.sourceCount} sources, ${lintLarge.conceptCount} concepts, ${lintLarge.topicCount} topics`,
      },
    );

    // ---- degradation gate ------------------------------------------------
    // Per-unit cost at large scale must stay within 3× of moderate.
    //
    // The per-unit derivation differs per scenario:
    //  - ingest: scenario's `perFile.medianMs` IS per-unit (each bench
    //    iteration was one source file).
    //  - lint: scenario's `result.medianMs` is whole-workspace; per-unit
    //    = median / wiki page count (concepts + topics).
    //
    // Computing per-unit at the CALL SITE — not inside the gate — keeps
    // the gate honest: it never has to guess what `medianMs` meant.
    console.log('=== 3× degradation gate ===');
    const lintModeratePages = lint.conceptCount + lint.topicCount;
    const lintLargePages = lintLarge.conceptCount + lintLarge.topicCount;
    const checks: DegradationCheck[] = [
      computeDegradation({
        scenario: 'ingest',
        moderate: { unitCount: ingest.sourceCount, perUnitMs: ingest.perFile.medianMs },
        large: { unitCount: ingestLarge.sourceCount, perUnitMs: ingestLarge.perFile.medianMs },
      }),
      computeDegradation({
        scenario: 'lint',
        moderate: {
          unitCount: lintModeratePages,
          perUnitMs: lintModeratePages > 0 ? lint.result.medianMs / lintModeratePages : 0,
        },
        large: {
          unitCount: lintLargePages,
          perUnitMs: lintLargePages > 0 ? lintLarge.result.medianMs / lintLargePages : 0,
        },
      }),
    ];
    for (const c of checks) {
      console.log(formatDegradation(c));
    }
    console.log('');
    record.degradationChecks = checks;

    const failed = checks.filter((c) => !c.passed);
    if (failed.length > 0) {
      console.log(
        `⚠ ${failed.length} of ${checks.length} degradation check(s) exceeded the 3× cap — investigate as separate bead(s).`,
      );
      console.log('');
    }
  }

  // ---- persist ----------------------------------------------------------
  const resultsDir = resolve(import.meta.dirname, '..', 'results');
  mkdirSync(resultsDir, { recursive: true });
  const dateStr = startedAt.replace(/[:.]/g, '-');
  const outPath = resolve(resultsDir, `${dateStr}-${gitSha}.json`);
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  console.log(`wrote: ${outPath}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
