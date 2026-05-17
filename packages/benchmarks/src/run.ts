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
}

/** Outcome shape every gated scenario returns. */
type GatedOutcome =
  | { ran: false; skipReason: string }
  | { ran: true; result: import('./utils/timer.js').BenchResult };

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
  const r = outcome.result;
  console.log(formatBenchResult(r));
  console.log(
    `  context: ${Object.entries(context)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ')}`,
  );
  console.log('');
  record.scenarios.push({
    name,
    medianMs: r.medianMs,
    minMs: r.minMs,
    maxMs: r.maxMs,
    rssDeltaMb: r.rssDeltaMb,
    iterations: r.samplesMs.length,
    samplesMs: r.samplesMs,
    context,
  });
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
  console.log(formatBenchResult(ingest.perFile));
  console.log(
    `  batchTotal=${ingest.batchTotalMs.toFixed(0)}ms over ${ingest.sourceCount} sources`,
  );
  console.log('');
  record.scenarios.push({
    name: 'ingest',
    medianMs: ingest.perFile.medianMs,
    minMs: ingest.perFile.minMs,
    maxMs: ingest.perFile.maxMs,
    rssDeltaMb: ingest.perFile.rssDeltaMb,
    iterations: ingest.perFile.samplesMs.length,
    samplesMs: ingest.perFile.samplesMs,
    batchTotalMs: ingest.batchTotalMs,
    context: { sourceCount: ingest.sourceCount },
  });

  // ---- lint -------------------------------------------------------------
  const lint = await runLintScenario();
  console.log(formatBenchResult(lint.result));
  console.log(
    `  context: ${lint.sourceCount} sources, ${lint.conceptCount} concepts, ${lint.topicCount} topics`,
  );
  console.log('');
  record.scenarios.push({
    name: 'lint',
    medianMs: lint.result.medianMs,
    minMs: lint.result.minMs,
    maxMs: lint.result.maxMs,
    rssDeltaMb: lint.result.rssDeltaMb,
    iterations: lint.result.samplesMs.length,
    samplesMs: lint.result.samplesMs,
    context: {
      sourceCount: lint.sourceCount,
      conceptCount: lint.conceptCount,
      topicCount: lint.topicCount,
    },
  });

  // ---- compile (Claude-gated) ------------------------------------------
  const compile = await runCompileScenario();
  recordGatedScenario(
    'compile',
    {
      sourceCount: compile.sourceCount,
      ...(compile.perPhaseMs !== undefined && {
        summarizeMs: compile.perPhaseMs.summarize,
        extractMs: compile.perPhaseMs.extract,
        synthesizeMs: compile.perPhaseMs.synthesize,
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

  // ---- persist ----------------------------------------------------------
  const resultsDir = resolve(import.meta.dirname, '..', 'results');
  mkdirSync(resultsDir, { recursive: true });
  const dateStr = startedAt.replace(/[:.]/g, '-');
  const outPath = resolve(resultsDir, `${dateStr}-${gitSha}.json`);
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  console.log(`wrote: ${outPath}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
