/**
 * Tests for the compile-faithfulness (groundedness) eval handler (e06.8).
 *
 * Real workspace + DB, STUBBED judge — deterministic and zero-cost. The stub
 * inspects the page content and returns supported/unsupported verdicts, so we
 * assert the end-to-end contract without any network call:
 *
 *   - a KNOWN-GROUNDED page (claims present in the raw source) scores HIGH
 *   - a FABRICATED/HALLUCINATED page (claims absent from the raw source) scores LOW
 *   - the judge's token cost is recorded in `compilations.faithfulness_tokens_used`
 *     while the compile-side `tokens_used` stays intact (cost parity)
 *   - the boundary holds: no knowledge is written back into the wiki/semantic tables
 *   - cross-source (junction) pages are traced + scored
 *   - an empty sample (no traceable pages) reports honestly, does not crash
 *   - a judge API error on one page is reported, does not abort the run
 *   - the eval.run + eval.result trace pair is emitted with a shared correlation_id
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDatabase,
  type Database,
  type FaithfulnessEvalSpec,
  initDatabase,
  initWorkspace,
  readTraces,
} from '@ico/kernel';
import { ok } from '@ico/types';

import type { ClaudeClient } from '../api/claude-client.js';
import { runFaithfulnessEval } from './faithfulness.js';

interface Env {
  base: string;
  wsRoot: string;
  db: Database;
}
let env: Env;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-faith-eval-'));
  const ws = initWorkspace('ws', base);
  if (!ws.ok) throw ws.error;
  const dbRes = initDatabase(ws.value.dbPath);
  if (!dbRes.ok) throw dbRes.error;
  env = { base, wsRoot: ws.value.root, db: dbRes.value };
});
afterEach(() => {
  closeDatabase(env.db);
  rmSync(env.base, { recursive: true, force: true });
});

// --- seeding helpers --------------------------------------------------------

function writeRaw(relFromRaw: string, content: string): string {
  const abs = resolve(env.wsRoot, 'raw', relFromRaw);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
  return `raw/${relFromRaw}`;
}

function writeWiki(relFromWiki: string, content: string): string {
  const abs = resolve(env.wsRoot, 'wiki', relFromWiki);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
  return `wiki/${relFromWiki}`;
}

function insertSource(id: string, path: string): void {
  env.db
    .prepare(
      `INSERT INTO sources (id, path, type, ingested_at, hash)
       VALUES (?, ?, 'markdown', '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(id, path, `hash-${id}`);
}

function insertCompilation(
  id: string,
  sourceId: string | null,
  type: string,
  outputPath: string,
  compiledAt: string,
  compileTokens = 400,
): void {
  env.db
    .prepare(
      `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, stale, model, tokens_used)
       VALUES (?, ?, ?, ?, ?, 0, 'deepseek-chat', ?)`,
    )
    .run(id, sourceId, type, outputPath, compiledAt, compileTokens);
}

function linkJunction(compId: string, sourceId: string): void {
  env.db
    .prepare(`INSERT INTO compilation_sources (compilation_id, source_id) VALUES (?, ?)`)
    .run(compId, sourceId);
}

function faithMeter(id: string): number | null {
  const row = env.db
    .prepare<
      [string],
      { faithfulness_tokens_used: number | null; tokens_used: number | null }
    >(`SELECT faithfulness_tokens_used, tokens_used FROM compilations WHERE id = ?`)
    .get(id);
  return row?.faithfulness_tokens_used ?? null;
}

function compileMeter(id: string): number | null {
  const row = env.db
    .prepare<
      [string],
      { tokens_used: number | null }
    >(`SELECT tokens_used FROM compilations WHERE id = ?`)
    .get(id);
  return row?.tokens_used ?? null;
}

// --- stubbed judge ----------------------------------------------------------

/**
 * A deterministic stub judge. It parses the <source> text out of the user
 * prompt and, for a fixed set of probe claims, marks each supported iff its
 * key phrase appears in the source. This lets one stub score BOTH a grounded
 * and a hallucinated page correctly from their real content — no network.
 */
function stubJudge(probes: string[], model = 'deepseek-chat'): ClaudeClient {
  return {
    createCompletion: vi.fn((_system: string, user: string) => {
      // The prompt XML-escapes content; decode the few entities we rely on.
      const decoded = user.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      // Everything inside <source ...>...</source> is the raw text.
      const sourceText = decoded
        .split('<source')
        .slice(1)
        .map((chunk) => chunk.slice(chunk.indexOf('>') + 1, chunk.indexOf('</source>')))
        .join('\n')
        .toLowerCase();
      const claims = probes.map((p) => ({
        claim: p,
        supported: sourceText.includes(p.toLowerCase()),
        why: sourceText.includes(p.toLowerCase()) ? 'present in source' : 'absent from source',
      }));
      return Promise.resolve(
        ok({
          content: JSON.stringify({ claims, summary: 'stub verdict' }),
          inputTokens: 300,
          outputTokens: 80,
          model,
          stopReason: 'end_turn',
        }),
      );
    }),
  };
}

function errorJudge(message: string): ClaudeClient {
  return {
    createCompletion: vi.fn().mockResolvedValue({ ok: false, error: new Error(message) }),
  };
}

function spec(overrides: Partial<FaithfulnessEvalSpec> = {}): FaithfulnessEvalSpec {
  return {
    id: 'faithfulness-nightly',
    name: 'Sampled compile-faithfulness',
    type: 'faithfulness',
    sample_size: 5,
    threshold: 0.8,
    ...overrides,
  };
}

// --- tests ------------------------------------------------------------------

describe('runFaithfulnessEval — grounded vs hallucinated', () => {
  it('scores a KNOWN-GROUNDED page HIGH', async () => {
    // Raw source states two facts. The compiled page repeats exactly those.
    writeRaw(
      'notes/hos.md',
      'The FMCSA 11-hour driving limit caps daily driving. IFTA reconciles fuel tax across jurisdictions.',
    );
    insertSource('s1', 'raw/notes/hos.md');
    writeWiki(
      'sources/hos.md',
      '---\ntype: source-summary\n---\nThe 11-hour driving limit caps daily driving. IFTA reconciles fuel tax.',
    );
    insertCompilation('c1', 's1', 'summary', 'wiki/sources/hos.md', '2026-02-01T00:00:00.000Z');

    const judge = stubJudge(['11-hour driving limit', 'IFTA reconciles fuel tax']);
    const res = await runFaithfulnessEval(env.db, env.wsRoot, spec(), judge);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.result.score).toBe(1); // both claims supported
    expect(res.value.result.passed).toBe(true);
    expect(res.value.report.pages[0]!.supported).toBe(2);
  });

  it('scores a FABRICATED/HALLUCINATED page LOW', async () => {
    // Raw source says nothing about the claims the page makes.
    writeRaw('notes/hos.md', 'This note is about restaurant prime-cost math and nothing else.');
    insertSource('s1', 'raw/notes/hos.md');
    writeWiki(
      'sources/hos.md',
      '---\ntype: source-summary\n---\nThe 11-hour driving limit caps daily driving. IFTA reconciles fuel tax.',
    );
    insertCompilation('c1', 's1', 'summary', 'wiki/sources/hos.md', '2026-02-01T00:00:00.000Z');

    const judge = stubJudge(['11-hour driving limit', 'IFTA reconciles fuel tax']);
    const res = await runFaithfulnessEval(env.db, env.wsRoot, spec(), judge);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.result.score).toBe(0); // neither claim supported
    expect(res.value.result.passed).toBe(false);
    expect(res.value.report.pages[0]!.supported).toBe(0);
  });
});

describe('runFaithfulnessEval — token meter (cost parity)', () => {
  it('records judge tokens in the sibling column, leaves compile tokens intact', async () => {
    writeRaw('n/a.md', 'alpha beta gamma');
    insertSource('s1', 'raw/n/a.md');
    writeWiki('sources/a.md', 'alpha beta');
    insertCompilation('c1', 's1', 'summary', 'wiki/sources/a.md', '2026-02-01T00:00:00.000Z', 777);

    const judge = stubJudge(['alpha']);
    const res = await runFaithfulnessEval(env.db, env.wsRoot, spec(), judge);
    expect(res.ok).toBe(true);
    // 300 input + 80 output = 380 judge tokens recorded on the sibling meter.
    expect(faithMeter('c1')).toBe(380);
    // Compile meter untouched — both numbers are visible side by side.
    expect(compileMeter('c1')).toBe(777);
    if (res.ok) {
      expect(res.value.report.totalJudgeTokens).toBe(380);
      expect(res.value.report.judgeModel).toBe('deepseek-chat');
      // Cost is priced at the DeepSeek rate, not the Anthropic fallback.
      expect(res.value.report.estimatedJudgeCostUsd).toBeGreaterThan(0);
      expect(res.value.report.estimatedJudgeCostUsd).toBeLessThan(0.001);
    }
  });
});

describe('runFaithfulnessEval — boundary + provenance', () => {
  it('writes NO knowledge back into the wiki (judge is diagnostic only)', async () => {
    const wikiPath = writeWiki('sources/a.md', 'alpha beta');
    writeRaw('n/a.md', 'alpha beta gamma');
    insertSource('s1', 'raw/n/a.md');
    insertCompilation('c1', 's1', 'summary', wikiPath, '2026-02-01T00:00:00.000Z');
    const before = readFileSync(resolve(env.wsRoot, wikiPath), 'utf-8');

    await runFaithfulnessEval(env.db, env.wsRoot, spec(), stubJudge(['alpha']));

    const after = readFileSync(resolve(env.wsRoot, wikiPath), 'utf-8');
    expect(after).toBe(before); // page unchanged — no durable knowledge write
  });

  it('traces + scores a cross-source (junction) page', async () => {
    writeRaw('n/a.md', 'the citadel is a military college');
    writeRaw('n/b.md', 'usmc stands for the marine corps');
    insertSource('s1', 'raw/n/a.md');
    insertSource('s2', 'raw/n/b.md');
    writeWiki(
      'topics/mil.md',
      'The Citadel is a military college. USMC stands for the Marine Corps.',
    );
    insertCompilation('t1', null, 'topic', 'wiki/topics/mil.md', '2026-02-01T00:00:00.000Z');
    linkJunction('t1', 's1');
    linkJunction('t1', 's2');

    const judge = stubJudge(['military college', 'marine corps']);
    const res = await runFaithfulnessEval(env.db, env.wsRoot, spec(), judge);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.report.pages[0]!.total).toBe(2);
    expect(res.value.report.pages[0]!.supported).toBe(2);
  });
});

describe('runFaithfulnessEval — honest failure modes', () => {
  it('reports an empty sample honestly (no traceable pages) without crashing', async () => {
    // A compilation with no provenance at all.
    writeWiki('topics/x.md', 'orphan page');
    insertCompilation('o1', null, 'topic', 'wiki/topics/x.md', '2026-02-01T00:00:00.000Z');

    const res = await runFaithfulnessEval(env.db, env.wsRoot, spec(), stubJudge(['x']));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.report.eligiblePages).toBe(0);
    expect(res.value.result.passed).toBe(false);
    expect(res.value.result.details).toContain('sample empty');
  });

  it('records a per-page judge error without aborting the run', async () => {
    writeRaw('n/a.md', 'alpha');
    insertSource('s1', 'raw/n/a.md');
    writeWiki('sources/a.md', 'alpha');
    insertCompilation('c1', 's1', 'summary', 'wiki/sources/a.md', '2026-02-01T00:00:00.000Z');

    const res = await runFaithfulnessEval(env.db, env.wsRoot, spec(), errorJudge('boom'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.report.pages[0]!.scored).toBe(false);
    expect(res.value.report.pages[0]!.note).toContain('judge error');
    // No scored pages → mean 0, fail — but the run itself completed.
    expect(res.value.result.passed).toBe(false);
  });

  it('flags a missing raw source on disk as a provenance break', async () => {
    // Source row points at a raw file that was never written.
    insertSource('s1', 'raw/n/missing.md');
    writeWiki('sources/a.md', 'alpha');
    insertCompilation('c1', 's1', 'summary', 'wiki/sources/a.md', '2026-02-01T00:00:00.000Z');

    const res = await runFaithfulnessEval(env.db, env.wsRoot, spec(), stubJudge(['alpha']));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.report.pages[0]!.scored).toBe(false);
    expect(res.value.report.pages[0]!.note).toContain('missing');
  });
});

describe('runFaithfulnessEval — trace contract', () => {
  it('emits eval.run + eval.result sharing a correlation_id', async () => {
    writeRaw('n/a.md', 'alpha');
    insertSource('s1', 'raw/n/a.md');
    writeWiki('sources/a.md', 'alpha');
    insertCompilation('c1', 's1', 'summary', 'wiki/sources/a.md', '2026-02-01T00:00:00.000Z');

    const cid = '11111111-1111-1111-1111-111111111111';
    await runFaithfulnessEval(env.db, env.wsRoot, spec(), stubJudge(['alpha']), {
      correlationId: cid,
    });

    const traces = readTraces(env.db, { correlationId: cid });
    expect(traces.ok).toBe(true);
    if (!traces.ok) return;
    const types = traces.value.map((t) => t.event_type).sort();
    expect(types).toEqual(['eval.result', 'eval.run']);
  });
});
