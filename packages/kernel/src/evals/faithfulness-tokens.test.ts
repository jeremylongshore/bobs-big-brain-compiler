/**
 * Tests for the faithfulness token-meter recorder (e06.8).
 *
 * Asserts:
 *   - the migration added the sibling column `faithfulness_tokens_used`
 *   - recording writes into the SIBLING column, leaving compile `tokens_used` intact
 *   - re-recording ADDS to the meter (cumulative), NULL treated as 0
 *   - a missing compilation id errors (no silent no-op)
 *   - negative / non-finite token counts are rejected
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, type Database, initDatabase, initWorkspace } from '../index.js';
import { recordFaithfulnessTokens } from './faithfulness-tokens.js';

interface Env {
  base: string;
  db: Database;
}
let env: Env;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-faith-tok-'));
  const ws = initWorkspace('ws', base);
  if (!ws.ok) throw ws.error;
  const dbRes = initDatabase(ws.value.dbPath);
  if (!dbRes.ok) throw dbRes.error;
  env = { base, db: dbRes.value };
});
afterEach(() => {
  closeDatabase(env.db);
  rmSync(env.base, { recursive: true, force: true });
});

function seedCompilation(id: string, compileTokens: number): void {
  env.db
    .prepare(
      `INSERT INTO sources (id, path, type, ingested_at, hash)
       VALUES (?, 'raw/a.md', 'markdown', '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(`src-${id}`, `hash-${id}`);
  env.db
    .prepare(
      `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, stale, model, tokens_used)
       VALUES (?, ?, 'summary', ?, '2026-01-01T00:00:00.000Z', 0, 'deepseek-chat', ?)`,
    )
    .run(id, `src-${id}`, `wiki/sources/${id}.md`, compileTokens);
}

function readMeters(id: string): { compile: number | null; faith: number | null } {
  const row = env.db
    .prepare<
      [string],
      { tokens_used: number | null; faithfulness_tokens_used: number | null }
    >(`SELECT tokens_used, faithfulness_tokens_used FROM compilations WHERE id = ?`)
    .get(id);
  return { compile: row?.tokens_used ?? null, faith: row?.faithfulness_tokens_used ?? null };
}

describe('migration 004 — faithfulness_tokens_used sibling column', () => {
  it('added a nullable sibling column, default NULL on new rows', () => {
    seedCompilation('c1', 500);
    const m = readMeters('c1');
    expect(m.compile).toBe(500);
    expect(m.faith).toBeNull(); // un-evaluated compilation carries NULL
  });
});

describe('recordFaithfulnessTokens', () => {
  it('writes into the sibling column and leaves compile tokens intact (cost parity)', () => {
    seedCompilation('c1', 500);
    const res = recordFaithfulnessTokens(env.db, 'c1', 120);
    expect(res.ok).toBe(true);
    const m = readMeters('c1');
    expect(m.compile).toBe(500); // compile meter untouched — both visible side by side
    expect(m.faith).toBe(120);
  });

  it('accumulates on re-record (NULL treated as 0)', () => {
    seedCompilation('c1', 500);
    recordFaithfulnessTokens(env.db, 'c1', 100);
    recordFaithfulnessTokens(env.db, 'c1', 30);
    expect(readMeters('c1').faith).toBe(130);
  });

  it('errors when the compilation id is missing', () => {
    const res = recordFaithfulnessTokens(env.db, 'ghost', 100);
    expect(res.ok).toBe(false);
  });

  it('rejects negative or non-finite token counts', () => {
    seedCompilation('c1', 500);
    expect(recordFaithfulnessTokens(env.db, 'c1', -5).ok).toBe(false);
    expect(recordFaithfulnessTokens(env.db, 'c1', Number.NaN).ok).toBe(false);
    expect(readMeters('c1').faith).toBeNull(); // nothing recorded on rejection
  });
});
