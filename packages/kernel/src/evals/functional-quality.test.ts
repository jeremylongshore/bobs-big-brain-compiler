/**
 * Tests for the functional-quality eval type — loader validation, the
 * deterministic grading handler, and a guard that every generated spec in
 * the dogfood bank validates.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  createSearchIndex,
  type Database,
  indexCompiledPages,
  initDatabase,
  initWorkspace,
} from '../index.js';
import { loadEvalSpec } from './loader.js';
import { runEval } from './runner.js';
import type { FunctionalQualityEvalSpec } from './types.js';

interface Env {
  base: string;
  wsRoot: string;
  db: Database;
}
let env: Env;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-fq-'));
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
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, body, 'utf-8');
  return abs;
}

function seedWiki(dir: string, slug: string, title: string, body: string): void {
  const abs = resolve(env.wsRoot, 'wiki', dir, `${slug}.md`);
  mkdirSync(resolve(env.wsRoot, 'wiki', dir), { recursive: true });
  writeFileSync(abs, ['---', `title: ${title}`, 'type: concept', '---', '', body, ''].join('\n'));
}

// ---------------------------------------------------------------------------
// Loader validation
// ---------------------------------------------------------------------------

describe('loader — functional-quality', () => {
  const base = [
    'id: fq1',
    'name: FQ One',
    'type: functional-quality',
    "question: 'what is the kernel role'",
  ].join('\n');

  it('accepts a well-formed spec', () => {
    const p = writeSpec(
      'evals/ok.eval.yaml',
      [
        base,
        'expected_substrings:',
        '  - kernel',
        'expected_sources:',
        '  - CLAUDE.md',
        'recall_floor: 0.6',
        'verification_mode: strong',
      ].join('\n'),
    );
    const r = loadEvalSpec(p);
    expect(r.ok).toBe(true);
  });

  it('rejects an empty question', () => {
    const p = writeSpec(
      'evals/noq.eval.yaml',
      [
        'id: x',
        'name: x',
        'type: functional-quality',
        "question: ''",
        'expected_substrings: [a]',
        'expected_sources: [b]',
      ].join('\n'),
    );
    const r = loadEvalSpec(p);
    expect(r.ok).toBe(false);
  });

  it('rejects empty expected_substrings', () => {
    const p = writeSpec(
      'evals/nosub.eval.yaml',
      [base, 'expected_substrings: []', 'expected_sources: [b]'].join('\n'),
    );
    expect(loadEvalSpec(p).ok).toBe(false);
  });

  it('rejects empty expected_sources', () => {
    const p = writeSpec(
      'evals/nosrc.eval.yaml',
      [base, 'expected_substrings: [a]', 'expected_sources: []'].join('\n'),
    );
    expect(loadEvalSpec(p).ok).toBe(false);
  });

  it('rejects recall_floor out of [0,1]', () => {
    const p = writeSpec(
      'evals/badfloor.eval.yaml',
      [base, 'expected_substrings: [a]', 'expected_sources: [b]', 'recall_floor: 1.5'].join('\n'),
    );
    expect(loadEvalSpec(p).ok).toBe(false);
  });

  it('rejects an unknown verification_mode', () => {
    const p = writeSpec(
      'evals/badmode.eval.yaml',
      [base, 'expected_substrings: [a]', 'expected_sources: [b]', 'verification_mode: medium'].join(
        '\n',
      ),
    );
    expect(loadEvalSpec(p).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Handler grading
// ---------------------------------------------------------------------------

describe('handler — functional-quality grading', () => {
  function spec(overrides: Partial<FunctionalQualityEvalSpec>): FunctionalQualityEvalSpec {
    return {
      id: 'fq-test',
      name: 'FQ Test',
      type: 'functional-quality',
      question: 'what is intent-eval-core role',
      expected_substrings: ['kernel', 'contracts', 'no runtime'],
      expected_sources: ['kernel-role.md'],
      recall_floor: 0.6,
      threshold: 1,
      ...overrides,
    };
  }

  function seedAndIndex(): void {
    seedWiki(
      'concepts',
      'kernel-role',
      'Kernel Role',
      'intent-eval-core is the kernel. It holds the contracts. It has no runtime execution.',
    );
    const idx = indexCompiledPages(env.db, env.wsRoot);
    if (!idx.ok) throw idx.error;
  }

  it('passes when all sources recalled and all substrings grounded', () => {
    seedAndIndex();
    const r = runEval(env.db, env.wsRoot, spec({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.passed).toBe(true);
    expect(r.value.score).toBe(1);
  });

  it('fails when a substring is absent from the retrieved bodies (grounding < 1)', () => {
    seedAndIndex();
    const r = runEval(
      env.db,
      env.wsRoot,
      spec({ expected_substrings: ['kernel', 'a-fact-that-is-not-present-anywhere'] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.passed).toBe(false);
    expect(r.value.score).toBeLessThan(1);
    expect(r.value.details).toContain('ungrounded');
  });

  it('fails on recall_floor when an expected source never surfaces', () => {
    seedAndIndex();
    const r = runEval(
      env.db,
      env.wsRoot,
      // 1 of 2 sources retrievable -> source_recall 0.5 < floor 0.6
      spec({
        expected_sources: ['kernel-role.md', 'never-indexed.md'],
        recall_floor: 0.6,
        threshold: 0,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.passed).toBe(false);
    expect(r.value.details).toContain('recall floor');
  });

  it('grounding is case-insensitive', () => {
    seedAndIndex();
    const r = runEval(env.db, env.wsRoot, spec({ expected_substrings: ['KERNEL', 'CONTRACTS'] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.passed).toBe(true);
  });

  it('returns score 0 when the question has no searchable terms', () => {
    seedAndIndex();
    const r = runEval(env.db, env.wsRoot, spec({ question: 'the a is of' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.score).toBe(0);
    expect(r.value.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Generated-spec guard
// ---------------------------------------------------------------------------

describe('generated dogfood specs validate', () => {
  it('every generated intent-eval-core-v2 functional-quality spec loads cleanly', () => {
    // repo root: packages/kernel/src/evals -> up 4
    const repoRoot = resolve(__dirname, '..', '..', '..', '..');
    const dir = join(repoRoot, 'dogfood', 'evals', 'functional-quality', 'intent-eval-core-v2');
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.eval.yaml'));
    } catch {
      // Generated specs not present (e.g. partial checkout) — skip rather
      // than fail; the generator test path is exercised in CI where they exist.
      return;
    }
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const r = loadEvalSpec(join(dir, f));
      expect(r.ok, `${f} should validate`).toBe(true);
    }
  });
});
