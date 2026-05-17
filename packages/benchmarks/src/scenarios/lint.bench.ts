/**
 * Lint benchmark (E10-B06).
 *
 * Target from epic-10: `ico lint` < 30 s on a moderate corpus.
 *
 * Lint exercises four checks:
 *   1. Schema validation across every wiki page.
 *   2. Staleness — wiki pages older than their source.
 *   3. Uncompiled — sources with no corresponding wiki page.
 *   4. Orphans — wiki pages no other page references.
 *
 * To produce a realistic shape, the fixture builds a workspace with
 * both ingested raw sources (so staleness/uncompiled checks have rows
 * to walk) AND synthetic compiled wiki pages (so schema/orphan checks
 * have real frontmatter to validate).
 *
 * Pure-kernel — no Claude API key required. Always runs.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runIngestPipeline, runLint } from '@ico/compiler';
import { initWorkspace } from '@ico/kernel';

import { generateCorpus } from '../utils/corpus.js';
import { bench, type BenchResult } from '../utils/timer.js';
import { generateWiki } from '../utils/wiki.js';

export interface LintScenarioOptions {
  /** Number of raw sources to ingest. Default 50. */
  sourceCount?: number;
  /** Number of compiled concept pages to synthesise. Default 25. */
  conceptCount?: number;
  /** Number of compiled topic pages to synthesise. Default 5. */
  topicCount?: number;
  /** PRNG seeds for fixture generation. */
  corpusSeed?: number;
  wikiSeed?: number;
  /** Iterations of runLint. Median is reported. Default 5. */
  iterations?: number;
}

export interface LintScenarioOutput {
  /** Per-call bench result for runLint over the prepared workspace. */
  result: BenchResult;
  /** Sources ingested into the fixture. */
  sourceCount: number;
  /** Wiki pages synthesised into the fixture. */
  conceptCount: number;
  topicCount: number;
}

export async function runLintScenario(
  options: LintScenarioOptions = {},
): Promise<LintScenarioOutput> {
  const sourceCount = options.sourceCount ?? 50;
  const conceptCount = options.conceptCount ?? 25;
  const topicCount = options.topicCount ?? 5;
  const corpusSeed = options.corpusSeed ?? 0xb061;
  const wikiSeed = options.wikiSeed ?? 0xb062;
  const iterations = options.iterations ?? 5;

  // Create both temp dirs inside the try so a failure in the second
  // mkdtemp call still cleans up the first via the finally. Without
  // this, an OS-level mkdtemp failure (e.g. ENOSPC, EACCES) would
  // leak wsBase. PR #69 review.
  let wsBase: string | undefined;
  let corpusDir: string | undefined;

  try {
    wsBase = mkdtempSync(join(tmpdir(), 'ico-bench-lint-ws-'));
    corpusDir = mkdtempSync(join(tmpdir(), 'ico-bench-lint-corpus-'));

    const wsResult = initWorkspace('bench-ws', wsBase);
    if (!wsResult.ok) throw wsResult.error;
    const { root: workspacePath, dbPath } = wsResult.value;

    // 1. Ingest raw sources so the DB-backed checks have rows to walk.
    const corpus = generateCorpus({
      outputDir: corpusDir,
      sourceCount,
      bodyWords: 300,
      seed: corpusSeed,
    });
    for (const file of corpus.files) {
      const r = await runIngestPipeline(file, { workspacePath, dbPath });
      if (!r.ok) throw r.error;
    }

    // 2. Generate synthetic compiled wiki pages so schema/orphan checks
    // have real frontmatter to validate.
    generateWiki({
      workspacePath,
      conceptCount,
      topicCount,
      seed: wikiSeed,
    });

    // 3. Bench runLint. It's synchronous — wrap in an async no-op.
    const result = await bench(
      `lint (${sourceCount} sources, ${conceptCount} concepts, ${topicCount} topics)`,
      () => {
        const r = runLint(workspacePath, dbPath);
        // Defeat dead-code elimination — touch the result.
        if (typeof r !== 'object') throw new Error('lint returned non-object');
      },
      { iterations, warmup: 1 },
    );

    return { result, sourceCount, conceptCount, topicCount };
  } finally {
    if (corpusDir !== undefined) rmSync(corpusDir, { recursive: true, force: true });
    if (wsBase !== undefined) rmSync(wsBase, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const out = await runLintScenario();
  console.log(
    `lint: median=${out.result.medianMs.toFixed(1)}ms ` +
      `min=${out.result.minMs.toFixed(1)}ms ` +
      `max=${out.result.maxMs.toFixed(1)}ms ` +
      `Δrss=${out.result.rssDeltaMb.toFixed(1)}MB ` +
      `(${out.sourceCount} sources, ${out.conceptCount} concepts, ${out.topicCount} topics)`,
  );
}

const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  void main();
}
