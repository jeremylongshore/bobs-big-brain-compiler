/**
 * Render benchmark (E10-B06).
 *
 * Target from epic-10: `ico render report <topic>` < 5 s per report.
 *
 * `renderReport` calls Claude to synthesise a structured report from
 * compiled wiki pages — so this scenario is Claude-gated. Default
 * `pnpm bench` invocations skip it and emit a `{ skipped: true }`
 * record. Opt in with both:
 *
 *   ANTHROPIC_API_KEY=sk-...  ICO_BENCH_INCLUDE_CLAUDE=1 pnpm bench
 *
 * Methodology:
 *  1. Spin up a fresh workspace.
 *  2. Generate N synthetic concept pages (the source material).
 *  3. Read them as ReportSource[].
 *  4. Time renderReport across `iterations` calls; report median.
 *  5. Tear down.
 *
 * Each iteration is a fresh Claude call — counts against your API
 * spend. Default iterations = 1 to minimise spend on opt-in runs;
 * crank up via options when running a real benchmark sweep.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createClaudeClient, renderReport, type ReportSource } from '@ico/compiler';
import { initWorkspace } from '@ico/kernel';

import { checkClaudeGate } from '../utils/claude-gate.js';
import { bench, type BenchResult } from '../utils/timer.js';
import { generateWiki } from '../utils/wiki.js';

export interface RenderScenarioOptions {
  /** Number of concept pages to feed renderReport. Default 5. */
  conceptCount?: number;
  /** Iterations of renderReport. Median is reported. Default 1 (spend control). */
  iterations?: number;
  /** PRNG seed for the wiki fixture. */
  wikiSeed?: number;
  /** Model override for the Claude call. Default uses client default. */
  model?: string;
  /** Max output tokens. Default 1024 to keep cost predictable. */
  maxTokens?: number;
}

export interface RenderScenarioOutput {
  /** Whether the scenario actually ran a Claude call. */
  ran: boolean;
  /** Reason text when `ran === false`. */
  skipReason?: string;
  /** Bench result, present only when `ran === true`. */
  result?: BenchResult;
  /** Number of source pages fed into the render. */
  conceptCount: number;
}

export async function runRenderScenario(
  options: RenderScenarioOptions = {},
): Promise<RenderScenarioOutput> {
  const conceptCount = options.conceptCount ?? 5;
  const iterations = options.iterations ?? 1;
  const wikiSeed = options.wikiSeed ?? 0xb063;
  const maxTokens = options.maxTokens ?? 1024;

  const gate = checkClaudeGate();
  if (!gate.enabled) {
    return {
      ran: false,
      skipReason: gate.reason,
      conceptCount,
    };
  }

  let wsBase: string | undefined;
  try {
    wsBase = mkdtempSync(join(tmpdir(), 'ico-bench-render-ws-'));
    const wsResult = initWorkspace('bench-ws', wsBase);
    if (!wsResult.ok) throw wsResult.error;
    const { root: workspacePath } = wsResult.value;

    const wiki = generateWiki({
      workspacePath,
      conceptCount,
      topicCount: 0,
      bodyWords: 400,
      seed: wikiSeed,
    });

    // Read every generated concept page as a ReportSource. The
    // `path` is the workspace-relative path used in renderReport's
    // frontmatter; we strip the workspace prefix here.
    const sources: ReportSource[] = wiki.conceptPaths.map((absPath) => {
      const content = readFileSync(absPath, 'utf-8');
      const relPath = absPath.startsWith(workspacePath)
        ? absPath.slice(workspacePath.length).replace(/^[\\/]/, '')
        : absPath;
      // Extract the human-readable title from the frontmatter so the
      // Claude-generated citations in the report use natural titles
      // ("Attention Mechanism 0") rather than slugs
      // ("attention-mechanism-0"). The wiki generator emits unquoted
      // `title: <text>` — a single anchored regex is enough.
      const titleMatch = /^title:\s*(.+)$/m.exec(content);
      const title = titleMatch?.[1]?.trim() ?? '(untitled)';
      return { title, content, path: relPath };
    });

    const client = createClaudeClient(gate.apiKey!);

    const result = await bench(
      `render report (${conceptCount} source pages)`,
      async () => {
        const r = await renderReport(workspacePath, sources, {
          client,
          ...(options.model !== undefined && { model: options.model }),
          maxTokens,
          // Override the output path so iterations don't collide on disk.
          outputPath: join(workspacePath, 'outputs', `report-${Date.now()}-${Math.random()}.md`),
        });
        if (!r.ok) throw r.error;
      },
      { iterations },
    );

    return { ran: true, result, conceptCount };
  } finally {
    if (wsBase !== undefined) rmSync(wsBase, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const out = await runRenderScenario();
  if (!out.ran) {
    console.log(`render: SKIPPED (${out.skipReason ?? 'unknown'})`);
    return;
  }
  const r = out.result!;
  console.log(
    `render: median=${r.medianMs.toFixed(1)}ms ` +
      `min=${r.minMs.toFixed(1)}ms ` +
      `max=${r.maxMs.toFixed(1)}ms ` +
      `Δrss=${r.rssDeltaMb.toFixed(1)}MB ` +
      `(${out.conceptCount} source pages, n=${r.samplesMs.length})`,
  );
}

const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  void main();
}
