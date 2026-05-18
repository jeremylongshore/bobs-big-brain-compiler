/**
 * Compile benchmark (E10-B06).
 *
 * Target from epic-10: `ico compile <topic>` < 30 s per topic.
 *
 * Claude-gated. The compile pipeline runs three sequential phases:
 *
 *   1. summarizeSource — one Claude call per ingested source.
 *   2. extractConcepts — one Claude call over all summaries.
 *   3. synthesizeTopics — one Claude call over summaries + concepts.
 *
 * Each phase is bench()ed separately so the JSON output records per-
 * phase cost. The headline `medianMs` is the total (sum across phases)
 * — that's the figure the operator perceives waiting for the full
 * compile pipeline.
 *
 * Spend control: defaults to 3 sources to keep a single benchmark run
 * cheap (~5 Claude calls total). Operators sweeping costs can crank
 * `sourceCount` up via the scenario options.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createClaudeClient,
  extractConcepts,
  runIngestPipeline,
  summarizeSource,
  synthesizeTopics,
} from '@ico/compiler';
import { closeDatabase, initDatabase, initWorkspace, listSources } from '@ico/kernel';

import { checkClaudeGate } from '../utils/claude-gate.js';
import { generateCorpus } from '../utils/corpus.js';
import { bench, type BenchResult } from '../utils/timer.js';

export interface CompileScenarioOptions {
  /** Sources to ingest before compiling. Default 3 (spend control). */
  sourceCount?: number;
  /** Body words per source. Default 300 — large enough to be representative. */
  bodyWords?: number;
  /** Corpus generator seed. */
  corpusSeed?: number;
  /** Model override for Claude calls. */
  model?: string;
}

export interface CompileScenarioOutput {
  ran: boolean;
  skipReason?: string;
  /** Whole-pipeline timing (sum of all three phases). */
  result?: BenchResult;
  /**
   * Per-phase timing summary. Each phase reports the median across all
   * iterations plus the raw samples for transparency. Single-iteration
   * runs trivially have median === samples[0].
   */
  perPhaseMs?: {
    summarize: { medianMs: number; samplesMs: readonly number[] };
    extract: { medianMs: number; samplesMs: readonly number[] };
    synthesize: { medianMs: number; samplesMs: readonly number[] };
  };
  sourceCount: number;
}

export async function runCompileScenario(
  options: CompileScenarioOptions = {},
): Promise<CompileScenarioOutput> {
  const sourceCount = options.sourceCount ?? 3;
  const bodyWords = options.bodyWords ?? 300;
  const corpusSeed = options.corpusSeed ?? 0xb064;

  const gate = checkClaudeGate();
  if (!gate.enabled) {
    return { ran: false, skipReason: gate.reason, sourceCount };
  }

  let wsBase: string | undefined;
  let corpusDir: string | undefined;
  try {
    wsBase = mkdtempSync(join(tmpdir(), 'ico-bench-compile-ws-'));
    corpusDir = mkdtempSync(join(tmpdir(), 'ico-bench-compile-corpus-'));

    const wsResult = initWorkspace('bench-ws', wsBase);
    if (!wsResult.ok) throw wsResult.error;
    const { root: workspacePath, dbPath } = wsResult.value;

    // 1. Ingest fixtures (no Claude — populates raw/ + sources table).
    const corpus = generateCorpus({
      outputDir: corpusDir,
      sourceCount,
      bodyWords,
      seed: corpusSeed,
    });
    for (const file of corpus.files) {
      const r = await runIngestPipeline(file, { workspacePath, dbPath });
      if (!r.ok) throw r.error;
    }

    const client = createClaudeClient(gate.apiKey!);

    // Bench the whole pipeline as one timed run. Per-phase timings are
    // captured inside the bench callback. Each iteration appends to
    // the per-phase samples arrays so multi-iteration runs surface a
    // medianed phase breakdown (PR #71 review) — not just the last
    // iteration's values.
    const summarizeSamples: number[] = [];
    const extractSamples: number[] = [];
    const synthesizeSamples: number[] = [];
    const summaryPaths: string[] = [];

    const result = await bench(
      `compile (${sourceCount} sources)`,
      async () => {
        // Reset summary paths for the iteration; samples arrays
        // intentionally accumulate across iterations.
        summaryPaths.length = 0;

        // Open DB for the duration of this iteration's compile passes.
        // The passes manage their own transactions; we own the connection
        // lifecycle so the FTS5 / sources tables stay accessible.
        const dbRes = initDatabase(dbPath);
        if (!dbRes.ok) throw dbRes.error;
        const db = dbRes.value;

        try {
          // ---- Phase 1: summarize each ingested source --------------------
          const sourcesRes = listSources(db);
          if (!sourcesRes.ok) throw sourcesRes.error;
          const sources = sourcesRes.value;

          const summarizeStart = Date.now();
          for (const src of sources) {
            const sourceAbs = join(workspacePath, src.path);
            const content = readFileSync(sourceAbs, 'utf-8');
            const sr = await summarizeSource(
              client,
              db,
              workspacePath,
              src.id,
              content,
              src.path,
              src.hash,
              options.model !== undefined ? { model: options.model } : {},
            );
            if (!sr.ok) throw sr.error;
            summaryPaths.push(sr.value.outputPath);
          }
          summarizeSamples.push(Date.now() - summarizeStart);

          // ---- Phase 2: extract concepts ----------------------------------
          const extractStart = Date.now();
          const er = await extractConcepts(
            client,
            db,
            workspacePath,
            summaryPaths,
            options.model !== undefined ? { model: options.model } : {},
          );
          if (!er.ok) throw er.error;
          extractSamples.push(Date.now() - extractStart);

          // ---- Phase 3: synthesize topics --------------------------------
          const synthStart = Date.now();
          const yr = await synthesizeTopics(
            client,
            db,
            workspacePath,
            options.model !== undefined ? { model: options.model } : {},
          );
          if (!yr.ok) throw yr.error;
          synthesizeSamples.push(Date.now() - synthStart);
        } finally {
          closeDatabase(db);
        }
      },
      { iterations: 1 },
    );

    return {
      ran: true,
      result,
      perPhaseMs: {
        summarize: { medianMs: median(summarizeSamples), samplesMs: summarizeSamples },
        extract: { medianMs: median(extractSamples), samplesMs: extractSamples },
        synthesize: { medianMs: median(synthesizeSamples), samplesMs: synthesizeSamples },
      },
      sourceCount,
    };
  } finally {
    if (corpusDir !== undefined) rmSync(corpusDir, { recursive: true, force: true });
    if (wsBase !== undefined) rmSync(wsBase, { recursive: true, force: true });
  }
}

function median(samples: ReadonlyArray<number>): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function main(): Promise<void> {
  const out = await runCompileScenario();
  if (!out.ran) {
    console.log(`compile: SKIPPED (${out.skipReason ?? 'unknown'})`);
    return;
  }
  const r = out.result!;
  const p = out.perPhaseMs!;
  console.log(
    `compile: total=${r.medianMs.toFixed(0)}ms ` +
      `summarize=${p.summarize.medianMs}ms ` +
      `extract=${p.extract.medianMs}ms ` +
      `synthesize=${p.synthesize.medianMs}ms ` +
      `(${out.sourceCount} sources, n=${r.samplesMs.length})`,
  );
}

const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  void main();
}
