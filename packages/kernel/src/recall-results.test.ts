/**
 * Tests for `recall-results.ts` — the L5 row-level persistence layer used
 * by the Epic 9 quiz runner (B09) and the retention analyzer (B10).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, type Database, initDatabase, initWorkspace } from './index.js';
import { listRecallResults, recordRecallResult } from './recall-results.js';

interface Env {
  base: string;
  db: Database;
}

let env: Env;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-recall-results-'));
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

describe('recordRecallResult', () => {
  it('inserts a row with generated id and tested_at', () => {
    const r = recordRecallResult(env.db, {
      concept: 'self-attention',
      topic: 'transformers',
      correct: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.value.tested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.value.correct).toBe(1);
    expect(r.value.confidence).toBeNull();
    expect(r.value.source_card).toBeNull();
  });

  it('honours explicit id, testedAt, and confidence overrides', () => {
    const fixedId = '00000000-1111-2222-3333-444444444444';
    const r = recordRecallResult(env.db, {
      id: fixedId,
      concept: 'kv-cache',
      correct: false,
      confidence: 0.7,
      testedAt: '2026-04-08T12:00:00.000Z',
      sourceCard: 'recall/cards/kv-cache.md',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe(fixedId);
    expect(r.value.correct).toBe(0);
    expect(r.value.confidence).toBe(0.7);
    expect(r.value.tested_at).toBe('2026-04-08T12:00:00.000Z');
    expect(r.value.source_card).toBe('recall/cards/kv-cache.md');
  });

  it('rejects empty concept', () => {
    const r = recordRecallResult(env.db, { concept: '   ', correct: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('concept is required');
  });

  it('rejects out-of-range confidence', () => {
    const high = recordRecallResult(env.db, { concept: 'c', correct: true, confidence: 1.5 });
    expect(high.ok).toBe(false);

    const low = recordRecallResult(env.db, { concept: 'c', correct: true, confidence: -0.1 });
    expect(low.ok).toBe(false);
  });

  it('persists rows so listRecallResults reads them back', () => {
    recordRecallResult(env.db, { concept: 'a', correct: true });
    recordRecallResult(env.db, { concept: 'a', correct: false });
    recordRecallResult(env.db, { concept: 'b', correct: true, topic: 't' });

    const all = listRecallResults(env.db);
    if (!all.ok) throw all.error;
    expect(all.value).toHaveLength(3);

    const filterC = listRecallResults(env.db, { concept: 'a' });
    if (!filterC.ok) throw filterC.error;
    expect(filterC.value).toHaveLength(2);

    const filterT = listRecallResults(env.db, { topic: 't' });
    if (!filterT.ok) throw filterT.error;
    expect(filterT.value).toHaveLength(1);
    expect(filterT.value[0]!.concept).toBe('b');

    const limited = listRecallResults(env.db, { limit: 1 });
    if (!limited.ok) throw limited.error;
    expect(limited.value).toHaveLength(1);
  });
});
