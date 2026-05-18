/**
 * Ask benchmark (E10-B06).
 *
 * Target from epic-10: `ico ask <question>` < 10 s per query.
 *
 * Claude-gated. The ask flow is two steps:
 *
 *   1. analyzeQuestion — deterministic FTS5 search (no Claude).
 *   2. generateAnswer — Claude call with retrieved pages as context.
 *
 * Both are timed inside a single bench() so the headline number is
 * what the operator perceives between hitting enter and seeing the
 * answer.
 *
 * Fixture shortcut: we use the deterministic wiki generator to seed
 * compiled pages, then index them into FTS5. This skips the (very
 * expensive) compile pipeline. The downside is that retrieved
 * "relevant pages" are synthetic content — but the latency profile
 * of the ask flow doesn't depend on content quality, only on page
 * sizes and Claude's context-handling cost.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { analyzeQuestion, createClaudeClient, generateAnswer } from '@ico/compiler';
import {
  closeDatabase,
  createSearchIndex,
  indexCompiledPages,
  initDatabase,
  initWorkspace,
} from '@ico/kernel';

import { checkClaudeGate } from '../utils/claude-gate.js';
import { bench, type BenchResult } from '../utils/timer.js';
import { generateWiki } from '../utils/wiki.js';

export interface AskScenarioOptions {
  /** Concept pages to seed the wiki with. Default 25. */
  conceptCount?: number;
  /** Topic pages to seed the wiki with. Default 5. */
  topicCount?: number;
  /** Iterations of analyzeQuestion+generateAnswer. Default 1 (spend control). */
  iterations?: number;
  /** Question to ask. Default is a generic one likely to match seeded content. */
  question?: string;
  /** Max output tokens. Default 1024. */
  maxTokens?: number;
  /** PRNG seed for the wiki fixture. */
  wikiSeed?: number;
  /** Model override. */
  model?: string;
}

export interface AskScenarioOutput {
  ran: boolean;
  skipReason?: string;
  result?: BenchResult;
  conceptCount: number;
  topicCount: number;
  /** Number of relevant pages the FTS5 search surfaced for the question. */
  relevantPageCount?: number;
}

export async function runAskScenario(
  options: AskScenarioOptions = {},
): Promise<AskScenarioOutput> {
  const conceptCount = options.conceptCount ?? 25;
  const topicCount = options.topicCount ?? 5;
  const iterations = options.iterations ?? 1;
  // A query that overlaps the wiki generator's word bank
  // (attention/embedding/transformer/cache) so the FTS5 search returns
  // hits and the Claude call gets realistic context to work with.
  const question = options.question ?? 'What is the relationship between attention and embeddings?';
  const maxTokens = options.maxTokens ?? 1024;
  const wikiSeed = options.wikiSeed ?? 0xb065;

  const gate = checkClaudeGate();
  if (!gate.enabled) {
    return { ran: false, skipReason: gate.reason, conceptCount, topicCount };
  }

  let wsBase: string | undefined;
  try {
    wsBase = mkdtempSync(join(tmpdir(), 'ico-bench-ask-ws-'));
    const wsResult = initWorkspace('bench-ws', wsBase);
    if (!wsResult.ok) throw wsResult.error;
    const { root: workspacePath, dbPath } = wsResult.value;

    // Open the DB to set up FTS5 + index the seeded pages.
    const dbRes = initDatabase(dbPath);
    if (!dbRes.ok) throw dbRes.error;
    const db = dbRes.value;

    try {
      const idxInit = createSearchIndex(db);
      if (!idxInit.ok) throw idxInit.error;

      generateWiki({
        workspacePath,
        conceptCount,
        topicCount,
        bodyWords: 250,
        seed: wikiSeed,
      });

      const indexed = indexCompiledPages(db, workspacePath);
      if (!indexed.ok) throw indexed.error;
    } finally {
      closeDatabase(db);
    }

    const client = createClaudeClient(gate.apiKey!);

    // Capture relevantPageCount from the FIRST iteration only. The
    // value is deterministic on a fixed wiki+question, so the first
    // run is representative; reading the last-iteration value would
    // mask a fixture drift bug under multi-iteration runs (PR #71
    // review).
    let firstIterationPageCount: number | undefined;

    const result = await bench(
      `ask (${conceptCount} concepts, ${topicCount} topics)`,
      async () => {
        // Reopen the DB inside the timed region — matches the real
        // CLI invocation cost, which opens-then-closes for each command.
        const benchDb = initDatabase(dbPath);
        if (!benchDb.ok) throw benchDb.error;
        try {
          const analyzed = analyzeQuestion(benchDb.value, workspacePath, question);
          if (!analyzed.ok) throw analyzed.error;
          if (firstIterationPageCount === undefined) {
            firstIterationPageCount = analyzed.value.relevantPages.length;
          }

          // The CLI's ask command takes the top 5 retrieval hits and
          // reads each file from disk — replicate that exact behaviour
          // so the benchmark captures the same I/O profile.
          const topPages = analyzed.value.relevantPages.slice(0, 5);
          const pagesWithContent: Array<{ path: string; title: string; content: string }> = [];
          for (const p of topPages) {
            const absPath = join(workspacePath, 'wiki', p.path);
            try {
              const content = readFileSync(absPath, 'utf-8');
              pagesWithContent.push({ path: p.path, title: p.title, content });
            } catch {
              // Skip pages that fail to read — matches CLI behaviour.
            }
          }

          if (pagesWithContent.length === 0) {
            throw new Error(
              `analyzeQuestion returned no readable pages for "${question}" — fixture may not match question`,
            );
          }

          const answer = await generateAnswer(client, question, pagesWithContent, {
            maxTokens,
            ...(options.model !== undefined && { model: options.model }),
          });
          if (!answer.ok) throw answer.error;
        } finally {
          closeDatabase(benchDb.value);
        }
      },
      { iterations },
    );

    return {
      ran: true,
      result,
      conceptCount,
      topicCount,
      relevantPageCount: firstIterationPageCount ?? 0,
    };
  } finally {
    if (wsBase !== undefined) rmSync(wsBase, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const out = await runAskScenario();
  if (!out.ran) {
    console.log(`ask: SKIPPED (${out.skipReason ?? 'unknown'})`);
    return;
  }
  const r = out.result!;
  console.log(
    `ask: median=${r.medianMs.toFixed(0)}ms ` +
      `min=${r.minMs.toFixed(0)}ms max=${r.maxMs.toFixed(0)}ms ` +
      `(${out.conceptCount} concepts, ${out.topicCount} topics, ` +
      `${out.relevantPageCount ?? 0} relevant pages)`,
  );
}

const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  void main();
}
