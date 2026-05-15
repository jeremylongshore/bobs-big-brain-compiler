/**
 * Tests for `retention.ts` — retention scoring and weak-area tracking (E9-B10).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  type Database,
  initDatabase,
  initWorkspace,
  recordRecallResult,
} from './index.js';
import { getRetentionByConcept, getRetentionReport, getWeakAreas } from './retention.js';

interface Env {
  base: string;
  db: Database;
}
let env: Env;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-retention-'));
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

/** Seed N rows with `correctCount` correct answers spread across them. */
function seed(concept: string, correctCount: number, total: number): void {
  for (let i = 0; i < total; i += 1) {
    const r = recordRecallResult(env.db, {
      concept,
      correct: i < correctCount,
      testedAt: `2026-04-08T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
    });
    if (!r.ok) throw r.error;
  }
}

// ---------------------------------------------------------------------------
// getRetentionByConcept
// ---------------------------------------------------------------------------

describe('getRetentionByConcept', () => {
  it('returns null for unseen concepts', () => {
    const r = getRetentionByConcept(env.db, 'never-tested');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeNull();
  });

  it('returns correct ratio and last_tested_at for a tested concept', () => {
    seed('attention', 2, 3); // 2/3
    const r = getRetentionByConcept(env.db, 'attention');
    expect(r.ok).toBe(true);
    if (!r.ok || r.value === null) throw new Error('expected retention row');
    expect(r.value.total).toBe(3);
    expect(r.value.correct).toBe(2);
    expect(r.value.retention).toBeCloseTo(2 / 3, 5);
    expect(r.value.lastTestedAt).toBe('2026-04-08T12:00:00.000Z');
  });

  it('returns 0 retention when every answer is wrong', () => {
    seed('hard', 0, 4);
    const r = getRetentionByConcept(env.db, 'hard');
    expect(r.ok).toBe(true);
    if (!r.ok || r.value === null) throw new Error('expected row');
    expect(r.value.retention).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getWeakAreas
// ---------------------------------------------------------------------------

describe('getWeakAreas', () => {
  it('returns concepts sorted ascending by retention', () => {
    seed('alpha', 5, 5); // 1.0
    seed('beta', 1, 4); // 0.25
    seed('gamma', 2, 4); // 0.5
    seed('delta', 0, 3); // 0.0

    const r = getWeakAreas(env.db);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((c) => c.concept)).toEqual(['delta', 'beta', 'gamma', 'alpha']);
  });

  it('breaks retention ties by larger sample size first', () => {
    // both 0.5 retention; one has 4 rows, other 2 rows
    seed('big', 2, 4);
    seed('small', 1, 2);
    const r = getWeakAreas(env.db);
    if (!r.ok) throw r.error;
    expect(r.value[0]!.concept).toBe('big');
    expect(r.value[1]!.concept).toBe('small');
  });

  it('honours minSampleSize and maxRetention filters', () => {
    seed('weak-but-tiny', 0, 1); // 0.0, n=1
    seed('weak-and-tested', 0, 4); // 0.0, n=4
    seed('strong', 5, 5); // 1.0

    const r = getWeakAreas(env.db, { minSampleSize: 2, maxRetention: 0.5 });
    if (!r.ok) throw r.error;
    expect(r.value.map((c) => c.concept)).toEqual(['weak-and-tested']);
  });

  it('limits to N rows', () => {
    for (let i = 0; i < 15; i += 1) {
      seed(`concept-${i}`, i % 2, 2);
    }
    const r = getWeakAreas(env.db, { limit: 3 });
    if (!r.ok) throw r.error;
    expect(r.value).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// getRetentionReport
// ---------------------------------------------------------------------------

describe('getRetentionReport', () => {
  it('reports overall, weakest, strongest', () => {
    seed('a', 1, 4); // 0.25
    seed('b', 4, 4); // 1.0
    seed('c', 2, 4); // 0.5

    const r = getRetentionReport(env.db);
    if (!r.ok) throw r.error;
    expect(r.value.totalAnswers).toBe(12);
    expect(r.value.totalCorrect).toBe(7);
    expect(r.value.overall).toBeCloseTo(7 / 12, 5);
    expect(r.value.conceptCount).toBe(3);
    expect(r.value.weakest[0]!.concept).toBe('a');
    expect(r.value.strongest[0]!.concept).toBe('b');
  });

  it('handles the empty workspace', () => {
    const r = getRetentionReport(env.db);
    if (!r.ok) throw r.error;
    expect(r.value.totalAnswers).toBe(0);
    expect(r.value.overall).toBe(0);
    expect(r.value.conceptCount).toBe(0);
    expect(r.value.weakest).toHaveLength(0);
    expect(r.value.strongest).toHaveLength(0);
  });

  it('topN bounds the weakest and strongest lists separately', () => {
    for (let i = 0; i < 10; i += 1) {
      seed(`c-${i}`, i, 10); // retention 0..0.9 in steps of 0.1
    }
    const r = getRetentionReport(env.db, { topN: 2 });
    if (!r.ok) throw r.error;
    expect(r.value.weakest).toHaveLength(2);
    expect(r.value.strongest).toHaveLength(2);
    expect(r.value.weakest[0]!.concept).toBe('c-0');
    expect(r.value.strongest[0]!.concept).toBe('c-9');
  });
});
