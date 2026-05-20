/**
 * Ingest benchmark (E10-B06).
 *
 * Target from epic-10: per-source ingest <2 s on a moderate corpus.
 *
 * Methodology:
 *  1. Spin up a fresh workspace in tmpdir.
 *  2. Generate a synthetic corpus of N markdown sources (deterministic
 *     seed so the benchmark is reproducible run-to-run).
 *  3. Time `runIngestPipeline` over every file; report median per-file
 *     wall time and aggregate batch time.
 *  4. Tear down the workspace.
 *
 * Each file is ingested as its own measurement so the median reflects
 * steady-state cost, not a single big timing that mixes file-1 (cold
 * DB cache) with file-N (warm). The batch total is reported separately
 * because it answers "how long does the operator wait for a 50-source
 * import?" which is the user-visible budget.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runIngestPipeline } from '@ico/compiler';
import { initWorkspace } from '@ico/kernel';

import { generateCorpus } from '../utils/corpus.js';
import { bench, type BenchResult } from '../utils/timer.js';

export interface IngestScenarioOptions {
  /** Number of source files to ingest. Default 50 (moderate corpus per epic-10). */
  sourceCount?: number;
  /** Approximate body word count per source. Default 500. */
  bodyWords?: number;
  /** Corpus generator seed. Default 0xb06. */
  seed?: number;
}

export interface IngestScenarioOutput {
  /** Per-file median ingest cost. */
  perFile: BenchResult;
  /** Single-shot batch wall time across all files. */
  batchTotalMs: number;
  /** Number of files ingested. */
  sourceCount: number;
}

/**
 * Run the ingest scenario end-to-end and return both per-file and
 * batch totals. Caller owns nothing — temp directories are cleaned
 * before returning.
 */
export async function runIngestScenario(
  options: IngestScenarioOptions = {},
): Promise<IngestScenarioOutput> {
  const sourceCount = options.sourceCount ?? 50;
  const bodyWords = options.bodyWords ?? 500;
  const seed = options.seed ?? 0xb06;

  // Create both temp dirs inside the try so a second-mkdtemp failure
  // doesn't leak the first (PR #69 review).
  let workspaceBase: string | undefined;
  let corpusDir: string | undefined;

  try {
    workspaceBase = mkdtempSync(join(tmpdir(), 'ico-bench-ingest-ws-'));
    corpusDir = mkdtempSync(join(tmpdir(), 'ico-bench-ingest-corpus-'));

    const wsResult = initWorkspace('bench-ws', workspaceBase);
    if (!wsResult.ok) throw wsResult.error;
    const { root: workspacePath, dbPath } = wsResult.value;

    const corpus = generateCorpus({
      outputDir: corpusDir,
      sourceCount,
      bodyWords,
      seed,
    });

    // Per-file timing — iterate the corpus and bench each file as one
    // measurement. The median of N samples is the headline number.
    let nextFile = 0;
    const perFile = await bench(
      `ingest:per-file (${sourceCount} sources, ${bodyWords} words each)`,
      async () => {
        const file = corpus.files[nextFile]!;
        nextFile += 1;
        const r = await runIngestPipeline(file, { workspacePath, dbPath });
        if (!r.ok) throw r.error;
      },
      { iterations: sourceCount },
    );

    // Batch total is the sum of all per-file samples — runIngestPipeline
    // opens and closes the database every call, so this is a faithful
    // representation of CLI-driven batch import cost (matches what
    // `ico ingest dir/*.md` would observe).
    const batchTotalMs = perFile.samplesMs.reduce((a, b) => a + b, 0);

    return { perFile, batchTotalMs, sourceCount };
  } finally {
    if (corpusDir !== undefined) rmSync(corpusDir, { recursive: true, force: true });
    if (workspaceBase !== undefined) rmSync(workspaceBase, { recursive: true, force: true });
  }
}

/**
 * Stand-alone entry point so a developer can run just this scenario
 * with `tsx packages/benchmarks/src/scenarios/ingest.bench.ts`.
 */
async function main(): Promise<void> {
  const out = await runIngestScenario();
  console.log(`ingest: median per-file = ${out.perFile.medianMs.toFixed(1)} ms`);
  console.log(`ingest: min   per-file = ${out.perFile.minMs.toFixed(1)} ms`);
  console.log(`ingest: max   per-file = ${out.perFile.maxMs.toFixed(1)} ms`);
  console.log(
    `ingest: batch total    = ${out.batchTotalMs.toFixed(0)} ms over ${out.sourceCount} files`,
  );
  console.log(`ingest: Δrss            = ${out.perFile.rssDeltaMb.toFixed(1)} MB`);
}

// Allow direct execution via tsx. Compare import.meta.url to the entry
// path so main() doesn't fire when this module is imported by run.ts.
const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  void main();
}
