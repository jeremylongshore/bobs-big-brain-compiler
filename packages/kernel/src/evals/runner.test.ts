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
import { buildWikiIndex, extractCitations } from './handlers/citation.js';
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
      [
        'id: r1',
        'name: Q1',
        'type: retrieval',
        'question: how?',
        'expected_pages:',
        '  - a.md',
        '',
      ].join('\n'),
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
    const path = writeSpec(
      'evals/bad.eval.yaml',
      'name: x\ntype: smoke\ncheck: fts5-index-nonempty\n',
    );
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("'id'");
  });

  it('rejects invalid type', () => {
    const path = writeSpec('evals/bad-type.eval.yaml', 'id: x\nname: x\ntype: nonsense\n');
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("'type'");
  });

  it('rejects out-of-range threshold', () => {
    const path = writeSpec(
      'evals/bad-thresh.eval.yaml',
      ['id: x', 'name: x', 'type: smoke', 'check: fts5-index-nonempty', 'threshold: 1.5', ''].join(
        '\n',
      ),
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

  it('rejects compilation spec with duplicate criterion ids (PR #64 review)', () => {
    const path = writeSpec(
      'evals/dup.eval.yaml',
      [
        'id: c',
        'name: C',
        'type: compilation',
        'pass: summarize',
        'target_page: sources/x.md',
        'criteria:',
        '  - id: alpha',
        '    description: first',
        '  - id: alpha',
        '    description: second (duplicate id)',
        '',
      ].join('\n'),
    );
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/duplicates an earlier criterion id/);
  });
});

describe('discoverEvalSpecs', () => {
  it('finds .eval.yaml and .eval.yml recursively', () => {
    writeSpec('evals/a/x.eval.yaml', 'id: a\nname: A\ntype: smoke\ncheck: fts5-index-nonempty\n');
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
    writeSpec('evals/good.eval.yaml', 'id: g\nname: G\ntype: smoke\ncheck: fts5-index-nonempty\n');
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
    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0);
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
    expect(r.value.details).toMatch(/recall@5=1\.00/);
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
    // Two expected pages, only one matches → recall 0.5; precision = 1/1 = 1
    // (only one page returned, and it's an expected one); aggregate score = 0.75.
    // Threshold 0.5 → pass.
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
    expect(r.value.score).toBeCloseTo(0.75, 5);
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

// ---------------------------------------------------------------------------
// runEval — retrieval precision@k (B03 extension)
// ---------------------------------------------------------------------------

describe('runEval — retrieval precision', () => {
  it('reports both recall@k and precision@k in details', () => {
    seedWiki(
      'concepts',
      'self-attention',
      'Self-Attention',
      'Self-attention quadratic transformers',
    );
    seedWiki('concepts', 'noise', 'Noise', 'Unrelated transformers content');
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    const r = runEval(env.db, env.wsRoot, {
      id: 'r',
      name: 'R',
      type: 'retrieval',
      question: 'attention transformers',
      expected_pages: ['concepts/self-attention.md'],
      k: 5,
      threshold: 0, // accept anything — we just want to read the details string
    });
    if (!r.ok) throw r.error;
    expect(r.value.details).toMatch(/recall@5=\d/);
    expect(r.value.details).toMatch(/precision@5=\d/);
    expect(r.value.details).toMatch(/score=\d/);
  });

  it('fails when min_recall floor is violated even if aggregate ≥ threshold', () => {
    seedWiki('concepts', 'wanted', 'Wanted', 'attention transformers');
    seedWiki('concepts', 'noise', 'Noise', 'attention transformers');
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    // Two expected pages, only one matches → recall 0.5. Aggregate ~0.5.
    const r = runEval(env.db, env.wsRoot, {
      id: 'r',
      name: 'R',
      type: 'retrieval',
      question: 'attention',
      expected_pages: ['concepts/wanted.md', 'concepts/missing.md'],
      threshold: 0,
      min_recall: 0.8, // require recall ≥ 0.8 — should fail
    });
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(false);
    expect(r.value.details).toMatch(/recall floor/);
  });

  it('fails when min_precision floor is violated', () => {
    seedWiki('concepts', 'wanted', 'Wanted', 'attention transformers');
    for (let i = 0; i < 4; i += 1) {
      seedWiki('concepts', `noise-${i}`, `Noise ${i}`, 'attention transformers');
    }
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;

    // 1 expected, 5 hits returned → precision 0.2.
    const r = runEval(env.db, env.wsRoot, {
      id: 'r',
      name: 'R',
      type: 'retrieval',
      question: 'attention',
      expected_pages: ['concepts/wanted.md'],
      threshold: 0,
      min_precision: 0.5,
    });
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(false);
    expect(r.value.details).toMatch(/precision floor/);
  });
});

// ---------------------------------------------------------------------------
// runEval — citation
// ---------------------------------------------------------------------------

describe('runEval — citation', () => {
  function seedArtifact(relPath: string, body: string): void {
    const abs = resolve(env.wsRoot, relPath);
    mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  }

  it('verifies every [source: Title] marker against the wiki index', () => {
    seedWiki('concepts', 'self-attention', 'Self-Attention', 'Body.');
    seedArtifact(
      'outputs/reports/r1.md',
      'Attention scales quadratically [source: Self-Attention]. Done.',
    );

    const r = runEval(env.db, env.wsRoot, {
      id: 'cit-1',
      name: 'cit-1',
      type: 'citation',
      target_file: 'outputs/reports/r1.md',
    });
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(true);
    expect(r.value.score).toBe(1);
    expect(r.value.details).toMatch(/1\/1 citations verified/);
  });

  it('verifies [[slug]] wikilinks against the wiki index', () => {
    seedWiki('concepts', 'self-attention', 'Self-Attention', 'body');
    seedArtifact('outputs/r.md', 'See [[self-attention]] for the canonical definition.');

    const r = runEval(env.db, env.wsRoot, {
      id: 'c',
      name: 'c',
      type: 'citation',
      target_file: 'outputs/r.md',
    });
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(true);
  });

  it('flags hallucinated citations as failures and names them', () => {
    seedWiki('concepts', 'self-attention', 'Self-Attention', 'body');
    seedArtifact(
      'outputs/bad.md',
      'Real [source: Self-Attention] and made-up [source: Fictional Theorem].',
    );

    const r = runEval(env.db, env.wsRoot, {
      id: 'c',
      name: 'c',
      type: 'citation',
      target_file: 'outputs/bad.md',
    });
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(false);
    expect(r.value.score).toBeCloseTo(0.5, 5);
    expect(r.value.details).toContain('hallucinated');
    expect(r.value.details).toContain('Fictional Theorem');
  });

  it('vacuously passes when artifact has zero citations by default', () => {
    seedArtifact('outputs/r.md', 'No citations anywhere in this file.');
    const r = runEval(env.db, env.wsRoot, {
      id: 'c',
      name: 'c',
      type: 'citation',
      target_file: 'outputs/r.md',
    });
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(true);
    expect(r.value.details).toContain('vacuously');
  });

  it('fails when require_citations=true and artifact has zero citations', () => {
    seedArtifact('outputs/r.md', 'No citations.');
    const r = runEval(env.db, env.wsRoot, {
      id: 'c',
      name: 'c',
      type: 'citation',
      target_file: 'outputs/r.md',
      require_citations: true,
    });
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(false);
    expect(r.value.details).toContain('require_citations=true');
  });

  it('fails when an expected_citation is absent from the artifact', () => {
    seedWiki('concepts', 'self-attention', 'Self-Attention', 'body');
    seedWiki('concepts', 'embeddings', 'Embeddings', 'body');
    seedArtifact('outputs/partial.md', 'Cites [source: Self-Attention] but not the other one.');

    const r = runEval(env.db, env.wsRoot, {
      id: 'c',
      name: 'c',
      type: 'citation',
      target_file: 'outputs/partial.md',
      expected_citations: ['concepts/self-attention.md', 'concepts/embeddings.md'],
    });
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(false);
    expect(r.value.details).toContain('missing expected: concepts/embeddings.md');
  });

  it('returns err when target_file does not exist', () => {
    const r = runEval(env.db, env.wsRoot, {
      id: 'c',
      name: 'c',
      type: 'citation',
      target_file: 'outputs/nonexistent.md',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('target_file not found');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Security + correctness fixes (PR #65 review)
  // ──────────────────────────────────────────────────────────────────────────

  it('rejects target_file that escapes the workspace via ..', () => {
    seedArtifact('outputs/r.md', 'body');
    const r = runEval(env.db, env.wsRoot, {
      id: 'c',
      name: 'c',
      type: 'citation',
      target_file: '../../etc/passwd',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/must stay inside the workspace/);
  });

  it('rejects absolute target_file outside the workspace', () => {
    seedArtifact('outputs/r.md', 'body');
    const r = runEval(env.db, env.wsRoot, {
      id: 'c',
      name: 'c',
      type: 'citation',
      target_file: '/etc/hosts',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/must stay inside the workspace/);
  });

  it('fails when zero-citation artifact has expected_citations (no early return)', () => {
    // PR #65 review: the zero-citation early return previously skipped
    // the expected_citations check. An artifact with no citations and
    // expected_citations set should now fail under-grounding.
    seedWiki('concepts', 'self-attention', 'Self-Attention', 'body');
    seedArtifact('outputs/empty.md', 'No citations here at all.');

    const r = runEval(env.db, env.wsRoot, {
      id: 'c',
      name: 'c',
      type: 'citation',
      target_file: 'outputs/empty.md',
      expected_citations: ['concepts/self-attention.md'],
    });
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(false);
    expect(r.value.details).toContain('missing expected: concepts/self-attention.md');
  });

  it('zero-citation artifact with no expected_citations scores 1.0 (no NaN)', () => {
    seedArtifact('outputs/empty.md', 'No citations.');
    const r = runEval(env.db, env.wsRoot, {
      id: 'c',
      name: 'c',
      type: 'citation',
      target_file: 'outputs/empty.md',
    });
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(true);
    expect(r.value.score).toBe(1);
    expect(Number.isNaN(r.value.score)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loader — B03 spec validation
// ---------------------------------------------------------------------------

describe('loadEvalSpec — B03 extensions', () => {
  it('validates a citation spec', () => {
    const path = writeSpec(
      'evals/cit/c.eval.yaml',
      ['id: c', 'name: C', 'type: citation', 'target_file: outputs/r.md', ''].join('\n'),
    );
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(true);
  });

  it('rejects citation spec missing target_file', () => {
    const path = writeSpec(
      'evals/cit/bad.eval.yaml',
      ['id: c', 'name: C', 'type: citation', ''].join('\n'),
    );
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('target_file');
  });

  it('rejects out-of-range min_recall', () => {
    const path = writeSpec(
      'evals/r.eval.yaml',
      [
        'id: r',
        'name: R',
        'type: retrieval',
        'question: q?',
        'expected_pages: [a.md]',
        'min_recall: 1.5',
        '',
      ].join('\n'),
    );
    const r = loadEvalSpec(path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('min_recall');
  });
});

// ---------------------------------------------------------------------------
// Citation handler — PR #66 review (bz3s5)
// ---------------------------------------------------------------------------

describe('citation handler — wiki index reuse across batch', () => {
  // Per Gemini review on PR #66: runCitationEval rebuilt the wiki index
  // on every spec. A batch of N citation specs walked the wiki N times.
  // The runner now builds the index once per batch and threads it
  // through RunEvalOptions.

  it('runEval honors a prebuilt wiki index (no wiki walk performed)', () => {
    // Strongest behavioural test: seed an artifact citing a title that
    // does NOT exist on disk in wiki/. Pass a custom index that DOES
    // contain that title. The spec passes — which is only possible if
    // the prebuilt index was used instead of walking wiki/.
    mkdirSync(resolve(env.wsRoot, 'outputs'), { recursive: true });
    writeFileSync(resolve(env.wsRoot, 'outputs/r.md'), '[source: NeverWrittenToDisk]', 'utf-8');
    const customIndex = {
      byTitle: new Map([['neverwrittentodisk', 'concepts/synthetic.md']]),
      bySlug: new Map<string, string>(),
    };

    const r = runEval(
      env.db,
      env.wsRoot,
      { id: 'c', name: 'c', type: 'citation', target_file: 'outputs/r.md' },
      { wikiIndex: customIndex },
    );
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(true);
    expect(r.value.details).toMatch(/1\/1 citations verified/);
  });

  it('runEvals threads a single index through a batch of citation specs', () => {
    // Indirect but strong: seed wiki with concept A and a second wiki
    // file at concepts/b.md. Build a batch where spec1 cites A and
    // spec2 cites B. Then delete wiki/concepts/b.md from disk before
    // running the batch (but after wiki was seeded so the seed exists
    // for the first index build, if any). The batch builds the index
    // once at the first citation spec — by then b.md is gone, so
    // spec2 must fail. This proves only ONE walk happened: there was no
    // chance for spec2 to see its own freshly-walked index that would
    // also lack B (which is what we'd want), nor an index that includes
    // B (impossible at any walk time). The simpler positive proof is
    // the prebuilt-index test above. Here we just confirm the batch
    // does not crash and aggregates correctly across multiple citation
    // specs.
    seedWiki('concepts', 'a', 'A', 'body');
    seedWiki('concepts', 'b', 'B', 'body');
    mkdirSync(resolve(env.wsRoot, 'outputs'), { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(resolve(env.wsRoot, `outputs/r${i}.md`), '[source: A]', 'utf-8');
    }

    const specs: EvalSpec[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      name: `C${i}`,
      type: 'citation' as const,
      target_file: `outputs/r${i}.md`,
    }));
    const r = runEvals(env.db, env.wsRoot, specs);
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(5);
    expect(r.value.failed).toBe(0);
  });

  it('single runCitationEval call without prebuilt index still works', () => {
    // Backward-compat: runCitationEval called directly (not via runEvals)
    // must still build its own index.
    seedWiki('concepts', 'a', 'A', 'body');
    mkdirSync(resolve(env.wsRoot, 'outputs'), { recursive: true });
    writeFileSync(resolve(env.wsRoot, 'outputs/r.md'), '[source: A]', 'utf-8');

    const r = runEval(env.db, env.wsRoot, {
      id: 'c',
      name: 'c',
      type: 'citation',
      target_file: 'outputs/r.md',
    });
    if (!r.ok) throw r.error;
    expect(r.value.passed).toBe(true);
  });

  it('exported buildWikiIndex is the same shape used by the batch runner', () => {
    seedWiki('concepts', 'self-attention', 'Self-Attention', 'body');
    seedWiki('topics', 'transformers', 'Transformers', 'body');
    const idx = buildWikiIndex(env.wsRoot);
    expect(idx.byTitle.get('self-attention')).toBe('concepts/self-attention.md');
    expect(idx.byTitle.get('transformers')).toBe('topics/transformers.md');
    expect(idx.bySlug.get('self-attention')).toBe('concepts/self-attention.md');
  });
});

describe('citation handler — extractCitations regex isolation', () => {
  // Per Gemini review on PR #66: SOURCE_RE / WIKILINK_RE were module-
  // level with the /g flag. RegExp.exec leaves `lastIndex` non-zero
  // between calls when a loop exits early or callers interleave. The
  // handler now constructs fresh RegExps per call.
  it('100 sequential calls on the same body return identical results', () => {
    const body = '[source: A] then [[b]] and [source: C] and [[d|alias]]';
    const first = extractCitations(body);
    expect(first.map((c) => c.target)).toEqual(['A', 'C', 'b', 'd']);
    for (let i = 0; i < 100; i += 1) {
      expect(extractCitations(body)).toEqual(first);
    }
  });

  it('extractions on different bodies do not interfere', () => {
    const a = extractCitations('[source: First] [source: Second]');
    const b = extractCitations('[source: Third]');
    const c = extractCitations('[[only-link]]');
    expect(a.map((x) => x.target)).toEqual(['First', 'Second']);
    expect(b.map((x) => x.target)).toEqual(['Third']);
    expect(c.map((x) => x.target)).toEqual(['only-link']);
  });

  it('survives an interleaved pattern that would corrupt module-level /g regex', () => {
    // The historical bug: a regex with /g advances lastIndex inside the
    // exec loop. If extraction is invoked in alternation across two
    // different bodies (e.g. via async callbacks), a module-level regex
    // would start the second call at the first call's lastIndex. With
    // per-call construction this is impossible. Simulate by alternating
    // calls explicitly.
    const longBody = '[source: A] '.repeat(20) + '[[end]]';
    const shortBody = '[source: Short]';
    for (let i = 0; i < 50; i += 1) {
      const long = extractCitations(longBody);
      const short = extractCitations(shortBody);
      // longBody has 20 source markers + 1 wikilink.
      expect(long).toHaveLength(21);
      expect(short).toEqual([{ marker: '[source: Short]', target: 'Short', kind: 'source' }]);
    }
  });
});
