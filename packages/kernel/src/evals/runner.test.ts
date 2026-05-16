/**
 * Tests for the eval framework (E10-B01).
 *
 * Covers the loader (YAML parse + validation), per-handler dispatch,
 * trace emission contract, and batch aggregation behaviour.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createSearchIndex,
  createTask,
  type Database,
  indexCompiledPages,
  initDatabase,
  initWorkspace,
  readTraces,
  transitionTask,
  writeTrace,
} from '../index.js';
import { discoverEvalSpecs, loadAllEvalSpecs, loadEvalSpec } from './loader.js';
import { runEval, runEvals } from './runner.js';
import type { EvalSpec, RetrievalEvalSpec, SmokeEvalSpec } from './types.js';

interface Env {
  base: string;
  wsRoot: string;
  db: Database;
}
let env: Env;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-eval-'));
  const ws = initWorkspace('ws', base);
  if (!ws.ok) throw ws.error;
  const dbRes = initDatabase(ws.value.dbPath);
  if (!dbRes.ok) throw dbRes.error;
  const idx = createSearchIndex(dbRes.value);
  if (!idx.ok) throw idx.error;
  env = { base, wsRoot: ws.value.root, db: dbRes.value };
});
afterEach(() => {
  closeDatabase(env.db);
  rmSync(env.base, { recursive: true, force: true });
});

function writeSpec(relPath: string, body: string): string {
  const abs = resolve(env.wsRoot, relPath);
  const dir = abs.slice(0, abs.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, body, 'utf-8');
  return abs;
}

function seedWiki(dir: string, slug: string, title: string, body: string): void {
  const abs = resolve(env.wsRoot, 'wiki', dir, `${slug}.md`);
  mkdirSync(resolve(env.wsRoot, 'wiki', dir), { recursive: true });
  writeFileSync(
    abs,
    ['---', `title: ${title}`, 'type: concept', '---', '', body, ''].join('\n'),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// loader.ts
// ---------------------------------------------------------------------------

describe('loadEvalSpec', () => {
  it('loads a valid retrieval spec', () => {
    const path = writeSpec(
      'evals/retrieval/q1.eval.yaml',
      ['id: r1', 'name: Q1', 'type: retrieval', 'question: how?', 'expected_pages:', '  - a.md', ''].join('\n'),
    );
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe('r1');
    expect(r.value.type).toBe('retrieval');
  });

  it('loads a valid smoke spec', () => {
    const path = writeSpec(
      'evals/smoke/s.eval.yaml',
      ['id: s1', 'name: S1', 'type: smoke', 'check: fts5-index-nonempty', ''].join('\n'),
    );
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(true);
  });

  it('rejects missing id', () => {
    const path = writeSpec('evals/bad.eval.yaml', 'name: x\ntype: smoke\ncheck: fts5-index-nonempty\n');
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("'id'");
  });

  it('rejects invalid type', () => {
    const path = writeSpec(
      'evals/bad-type.eval.yaml',
      'id: x\nname: x\ntype: nonsense\n',
    );
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("'type'");
  });

  it('rejects out-of-range threshold', () => {
    const path = writeSpec(
      'evals/bad-thresh.eval.yaml',
      ['id: x', 'name: x', 'type: smoke', 'check: fts5-index-nonempty', 'threshold: 1.5', ''].join('\n'),
    );
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('threshold');
  });

  it('rejects retrieval spec without expected_pages', () => {
    const path = writeSpec(
      'evals/bad-ret.eval.yaml',
      ['id: x', 'name: x', 'type: retrieval', 'question: q?', ''].join('\n'),
    );
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('expected_pages');
  });

  it('rejects smoke spec with unknown check', () => {
    const path = writeSpec(
      'evals/bad-smoke.eval.yaml',
      ['id: x', 'name: x', 'type: smoke', 'check: invented-check', ''].join('\n'),
    );
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('check');
  });

  it('reports YAML parse errors with the source path', () => {
    const path = writeSpec('evals/syntax.eval.yaml', 'id: [unclosed\n');
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('YAML parse failed');
  });
});

describe('discoverEvalSpecs', () => {
  it('finds .eval.yaml and .eval.yml recursively', () => {
    writeSpec(
      'evals/a/x.eval.yaml',
      'id: a\nname: A\ntype: smoke\ncheck: fts5-index-nonempty\n',
    );
    writeSpec(
      'evals/a/nested/y.eval.yml',
      'id: b\nname: B\ntype: smoke\ncheck: fts5-index-nonempty\n',
    );
    // Non-eval files should be ignored.
    writeSpec('evals/a/README.md', '# notes\n');

    const r = discoverEvalSpecs(resolve(env.wsRoot, 'evals'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    expect(r.value.every((p) => /\.eval\.ya?ml$/.test(p))).toBe(true);
  });

  it('returns ok([]) when evals/ does not exist', () => {
    const r = discoverEvalSpecs(resolve(env.wsRoot, 'evals'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([]);
  });
});

describe('loadAllEvalSpecs', () => {
  it('returns one entry per discovered file with per-file Result', () => {
    writeSpec(
      'evals/good.eval.yaml',
      'id: g\nname: G\ntype: smoke\ncheck: fts5-index-nonempty\n',
    );
    writeSpec('evals/bad.eval.yaml', 'id: b\nname: B\ntype: NOPE\n');

    const r = loadAllEvalSpecs(resolve(env.wsRoot, 'evals'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    const good = r.value.find((e) => e.path.endsWith('good.eval.yaml'));
    const bad = r.value.find((e) => e.path.endsWith('bad.eval.yaml'));
    expect(good?.spec.ok).toBe(true);
    expect(bad?.spec.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runEval — smoke handler
// ---------------------------------------------------------------------------

describe('runEval — smoke', () => {
  it('fts5-index-nonempty fails on empty index', () => {
    const spec: SmokeEvalSpec = {
      id: 's',
      name: 'S',
      type: 'smoke',
      check: 'fts5-index-nonempty',
    };
    const r = runEval(env.db, env.wsRoot, spec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.passed).toBe(false);
    expect(r.value.score).toBe(0);
    expect(r.value.details).toContain('empty');
  });

  it('fts5-index-nonempty passes after compiled pages are indexed', () => {
    seedWiki('concepts', 'attention', 'Attention', 'Self-attention.');
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;
    const spec: SmokeEvalSpec = {
      id: 's',
      name: 'S',
      type: 'smoke',
      check: 'fts5-index-nonempty',
    };
    const r = runEval(env.db, env.wsRoot, spec);
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(true);
    expect(r.value.score).toBe(1);
  });

  it('no-failed-tasks fails when a failed task exists', () => {
    const t = createTask(env.db, env.wsRoot, 'b');
    if (!t.ok) throw t.error;
    const tr = transitionTask(env.db, env.wsRoot, t.value.id, 'failed_collecting');
    if (!tr.ok) throw tr.error;

    const spec: SmokeEvalSpec = {
      id: 's',
      name: 'S',
      type: 'smoke',
      check: 'no-failed-tasks',
    };
    const r = runEval(env.db, env.wsRoot, spec);
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(false);
    expect(r.value.details).toContain('failed_collecting');
  });

  it('audit-chain-intact passes on a clean trace history', () => {
    // Seed a couple of valid traces.
    writeTrace(env.db, env.wsRoot, 'test.a', { v: 1 });
    writeTrace(env.db, env.wsRoot, 'test.b', { v: 2 });
    const spec: SmokeEvalSpec = {
      id: 's',
      name: 'S',
      type: 'smoke',
      check: 'audit-chain-intact',
    };
    const r = runEval(env.db, env.wsRoot, spec);
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(true);
    expect(r.value.details).toContain('intact');
  });

  it('audit-chain-intact fails when a trace line is tampered with', () => {
    writeTrace(env.db, env.wsRoot, 'test.a', { v: 1 });
    writeTrace(env.db, env.wsRoot, 'test.b', { v: 2 });

    // Tamper: rewrite the second line so its prev_hash no longer matches.
    const today = new Date().toISOString().slice(0, 10);
    const path = resolve(env.wsRoot, 'audit', 'traces', `${today}.jsonl`);
    const lines = readFileSync(path, 'utf-8').split('\n').filter((l) => l.length > 0);
    const bad = JSON.parse(lines[1]!) as { prev_hash: string };
    bad.prev_hash = '0'.repeat(64);
    lines[1] = JSON.stringify(bad);
    writeFileSync(path, lines.join('\n') + '\n', 'utf-8');

    const spec: SmokeEvalSpec = {
      id: 's',
      name: 'S',
      type: 'smoke',
      check: 'audit-chain-intact',
    };
    const r = runEval(env.db, env.wsRoot, spec);
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(false);
    expect(r.value.details).toContain('chain broken');
  });
});

// ---------------------------------------------------------------------------
// runEval — retrieval handler
// ---------------------------------------------------------------------------

describe('runEval — retrieval', () => {
  function spec(overrides: Partial<RetrievalEvalSpec> = {}): RetrievalEvalSpec {
    return {
      id: 'r1',
      name: 'R1',
      type: 'retrieval',
      question: 'How does self-attention work in transformers?',
      expected_pages: ['concepts/self-attention.md'],
      ...overrides,
    };
  }

  it('passes when the expected page is in top-k', () => {
    seedWiki(
      'concepts',
      'self-attention',
      'Self-Attention',
      'Self-attention computes weighted sums over input positions in transformers.',
    );
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const r = runEval(env.db, env.wsRoot, spec());
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(true);
    expect(r.value.score).toBe(1);
    expect(r.value.details).toContain('1/1');
  });

  it('fails when the expected page is missing', () => {
    seedWiki(
      'concepts',
      'other',
      'Other Concept',
      'Something unrelated to attention or transformers.',
    );
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const r = runEval(env.db, env.wsRoot, spec());
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(false);
    expect(r.value.details).toContain('missing');
  });

  it('honours a lenient threshold (partial recall counts)', () => {
    // Two expected pages, only one matches → recall 0.5; threshold 0.5 → pass.
    seedWiki('concepts', 'a', 'A Concept', 'Attention in transformers explained.');
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const r = runEval(
      env.db,
      env.wsRoot,
      spec({ expected_pages: ['concepts/a.md', 'concepts/missing.md'], threshold: 0.5 }),
    );
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(true);
    expect(r.value.score).toBeCloseTo(0.5, 5);
  });
});

// ---------------------------------------------------------------------------
// runEval — trace contract
// ---------------------------------------------------------------------------

describe('runEval — trace contract', () => {
  it('emits eval.run + eval.result with shared correlation_id', () => {
    seedWiki('concepts', 'attention', 'Attention', 'Self-attention.');
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const correlationId = '11111111-2222-3333-4444-555555555555';
    runEval(
      env.db,
      env.wsRoot,
      { id: 's', name: 'S', type: 'smoke', check: 'fts5-index-nonempty' },
      { correlationId },
    );

    const start = readTraces(env.db, { eventType: 'eval.run' });
    if (!start.ok) throw start.error;
    const end = readTraces(env.db, { eventType: 'eval.result' });
    if (!end.ok) throw end.error;
    expect(start.value).toHaveLength(1);
    expect(end.value).toHaveLength(1);
    expect(start.value[0]!.correlation_id).toBe(correlationId);
    expect(end.value[0]!.correlation_id).toBe(correlationId);
  });
});

// ---------------------------------------------------------------------------
// runEvals — batch
// ---------------------------------------------------------------------------

describe('runEvals — batch', () => {
  it('runs every spec and aggregates counts', () => {
    seedWiki('concepts', 'a', 'A', 'attention transformers');
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const specs: EvalSpec[] = [
      { id: 's1', name: 'S1', type: 'smoke', check: 'fts5-index-nonempty' },
      { id: 's2', name: 'S2', type: 'smoke', check: 'no-failed-tasks' },
      {
        id: 'r1',
        name: 'R1',
        type: 'retrieval',
        question: 'attention',
        expected_pages: ['concepts/missing.md'],
      },
    ];

    const r = runEvals(env.db, env.wsRoot, specs);
    if (!r.ok) throw r.error;
    expect(r.value.total).toBe(3);
    expect(r.value.passed).toBe(2);
    expect(r.value.failed).toBe(1);
  });
});
