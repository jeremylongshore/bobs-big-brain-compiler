/**
 * Tests for the `ico eval run` command (E10-B01).
 *
 * Real workspace + DB + filesystem; no Claude. The kernel runner is
 * exercised against actual eval YAML files so the test catches the full
 * CLI → loader → runner → trace path.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/workspace-resolver.js', () => ({
  resolveWorkspace: vi.fn(),
}));

import {
  closeDatabase,
  createSearchIndex,
  indexCompiledPages,
  initDatabase,
  initWorkspace,
} from '@ico/kernel';

import { resolveWorkspace } from '../lib/workspace-resolver.js';
import { runEvalCommand } from './eval.js';

interface Env {
  base: string;
  wsRoot: string;
  dbPath: string;
}
let env: Env;

beforeEach(() => {
  vi.clearAllMocks();
  const base = mkdtempSync(join(tmpdir(), 'ico-eval-cli-'));
  const ws = initWorkspace('ws', base);
  if (!ws.ok) throw ws.error;
  const dbRes = initDatabase(ws.value.dbPath);
  if (!dbRes.ok) throw dbRes.error;
  const idx = createSearchIndex(dbRes.value);
  if (!idx.ok) throw idx.error;
  closeDatabase(dbRes.value);
  env = { base, wsRoot: ws.value.root, dbPath: ws.value.dbPath };
  vi.mocked(resolveWorkspace).mockReturnValue({
    ok: true,
    value: { root: env.wsRoot, dbPath: env.dbPath },
  });
});
afterEach(() => {
  rmSync(env.base, { recursive: true, force: true });
});

function writeSpec(rel: string, body: string): string {
  const abs = resolve(env.wsRoot, rel);
  mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
  writeFileSync(abs, body, 'utf-8');
  return abs;
}

function seedWiki(slug: string, body: string): void {
  const abs = resolve(env.wsRoot, 'wiki', 'concepts', `${slug}.md`);
  mkdirSync(resolve(env.wsRoot, 'wiki', 'concepts'), { recursive: true });
  writeFileSync(
    abs,
    ['---', `title: ${slug}`, 'type: concept', '---', '', body, ''].join('\n'),
    'utf-8',
  );
  // Re-open and re-index, then close so the CLI command can reopen.
  const db = initDatabase(env.dbPath);
  if (!db.ok) throw db.error;
  createSearchIndex(db.value);
  indexCompiledPages(db.value, env.wsRoot);
  closeDatabase(db.value);
}

// ---------------------------------------------------------------------------
// Discovery + run all
// ---------------------------------------------------------------------------

describe('runEvalCommand — discover + run all', () => {
  it('returns zero-spec batch when evals/ is missing', async () => {
    const r = await runEvalCommand({}, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.batch.total).toBe(0);
    expect(r.value.loadErrors).toHaveLength(0);
  });

  it('runs every discovered spec and aggregates pass/fail', async () => {
    writeSpec(
      'evals/smoke/passing.eval.yaml',
      'id: s-pass\nname: Pass\ntype: smoke\ncheck: no-failed-tasks\n',
    );
    writeSpec(
      'evals/smoke/failing.eval.yaml',
      'id: s-fail\nname: Fail\ntype: smoke\ncheck: fts5-index-nonempty\n',
    );

    const r = await runEvalCommand({}, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.batch.total).toBe(2);
    expect(r.value.batch.passed).toBe(1);
    expect(r.value.batch.failed).toBe(1);
  });

  it('surfaces malformed specs in loadErrors but still runs valid ones', async () => {
    writeSpec('evals/good.eval.yaml', 'id: g\nname: G\ntype: smoke\ncheck: no-failed-tasks\n');
    writeSpec('evals/bad.eval.yaml', 'this is not a valid spec\n');

    const r = await runEvalCommand({}, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.loadErrors).toHaveLength(1);
    expect(r.value.batch.total).toBe(1);
    expect(r.value.batch.passed).toBe(1);
  });

  it('passes retrieval evals when the expected page is indexed', async () => {
    seedWiki('self-attention', 'Self-attention scales quadratically in transformers.');
    writeSpec(
      'evals/r.eval.yaml',
      [
        'id: r1',
        'name: R1',
        'type: retrieval',
        'question: How does self-attention work?',
        'expected_pages:',
        '  - concepts/self-attention.md',
        '',
      ].join('\n'),
    );

    const r = await runEvalCommand({}, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.batch.passed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// --spec
// ---------------------------------------------------------------------------

describe('runEvalCommand — --spec', () => {
  it('runs only the requested spec', async () => {
    writeSpec(
      'evals/keep.eval.yaml',
      'id: keep\nname: keep\ntype: smoke\ncheck: no-failed-tasks\n',
    );
    writeSpec(
      'evals/skip.eval.yaml',
      'id: skip\nname: skip\ntype: smoke\ncheck: no-failed-tasks\n',
    );

    const r = await runEvalCommand({ spec: 'evals/keep.eval.yaml' }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.batch.total).toBe(1);
    expect(r.value.batch.results[0]!.spec.id).toBe('keep');
  });

  it('returns err when --spec points to a missing file', async () => {
    const r = await runEvalCommand({ spec: 'evals/missing.eval.yaml' }, {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('eval spec');
  });
});

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

describe('runEvalCommand — output modes', () => {
  it('emits JSON when --json is passed', async () => {
    writeSpec('evals/s.eval.yaml', 'id: s\nname: S\ntype: smoke\ncheck: no-failed-tasks\n');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runEvalCommand({}, { json: true });
    const joined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(joined).toContain('"batch"');
    expect(joined).toContain('"results"');
    expect(joined).toContain('"loadErrors"');
    writeSpy.mockRestore();
  });
});
