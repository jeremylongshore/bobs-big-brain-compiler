/**
 * Benchmark runner entry point (E10-B06).
 *
 * Executes every scenario, prints a single summary table, and writes a
 * JSON record under `results/` keyed by ISO-8601 date + git short SHA.
 * The JSON is the durable artefact — checked in as needed for trend
 * analysis, never edited by hand.
 *
 * Run from repo root: `pnpm bench` or
 *                     `pnpm --filter @ico/benchmarks bench`
 *
 * The runner is intentionally minimal in this first cut — one scenario,
 * one printed line, one JSON dump. Subsequent E10-B06 PRs add compile,
 * ask, render, lint scenarios + the large-corpus (500-source) run.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runIngestScenario } from './scenarios/ingest.bench.js';
import { formatBenchResult } from './utils/timer.js';

/** Best-effort git short SHA. Returns 'unknown' when git is unavailable. */
function gitShortSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

interface RunRecord {
  startedAt: string;
  gitSha: string;
  node: string;
  platform: NodeJS.Platform;
  scenarios: Array<{
    name: string;
    perFileMedianMs: number;
    perFileMinMs: number;
    perFileMaxMs: number;
    batchTotalMs: number;
    sourceCount: number;
    rssDeltaMb: number;
    samplesMs: readonly number[];
  }>;
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

  const ingest = await runIngestScenario();
  console.log(formatBenchResult(ingest.perFile));
  console.log(`  batchTotal=${ingest.batchTotalMs.toFixed(0)}ms over ${ingest.sourceCount} sources`);
  console.log('');

  record.scenarios.push({
    name: 'ingest',
    perFileMedianMs: ingest.perFile.medianMs,
    perFileMinMs: ingest.perFile.minMs,
    perFileMaxMs: ingest.perFile.maxMs,
    batchTotalMs: ingest.batchTotalMs,
    sourceCount: ingest.sourceCount,
    rssDeltaMb: ingest.perFile.rssDeltaMb,
    samplesMs: ingest.perFile.samplesMs,
  });

  // Persist. Filename includes date + git SHA so two runs on the same
  // commit don't collide, and a run on a dirty tree is still
  // distinguishable by timestamp.
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
