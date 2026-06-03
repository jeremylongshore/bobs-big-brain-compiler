/**
 * Property-based tests for `retention.ts` — the recall/retention scorer.
 *
 * Where the example-based `retention.test.ts` pins specific cases, this suite
 * asserts the *invariants* the deterministic scorer must uphold across
 * thousands of generated recall batches:
 *
 *  - retention is always a valid ratio `correct / total` in `[0, 1]`
 *  - report aggregates are internally consistent with the raw batch
 *  - weakest/strongest are sorted by the documented comparator and bounded by N
 *  - `getWeakAreas` respects `limit` / `minSampleSize` / `maxRetention` and is
 *    deterministic (same query → byte-identical result)
 *
 * Part of bead `intentional-cognition-os-0wy.8` (property tests for the
 * deterministic core).
 *
 * @module retention.property.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  type Database,
  initDatabase,
  initWorkspace,
  recordRecallResult,
} from './index.js';
import {
  type ConceptRetention,
  getRetentionByConcept,
  getRetentionReport,
  getWeakAreas,
} from './retention.js';

interface Env {
  base: string;
  db: Database;
}
let env: Env;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'ico-retention-prop-'));
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

// ---------------------------------------------------------------------------
// Generators + helpers
// ---------------------------------------------------------------------------

interface GenResult {
  concept: string;
  correct: boolean;
  hour: number;
}

const resultArb = fc.record({
  // A small concept pool so batches contain multiple rows per concept
  // (otherwise every concept is a one-shot and grouping is never exercised).
  concept: fc.constantFrom('alpha', 'beta', 'gamma', 'delta', 'epsilon'),
  correct: fc.boolean(),
  hour: fc.integer({ min: 0, max: 23 }),
});
const batchArb = fc.array(resultArb, { maxLength: 40 });

/** The exact tie-break comparator `retention.ts` uses for "weakest first". */
function weakCmp(a: ConceptRetention, b: ConceptRetention): number {
  if (a.retention !== b.retention) return a.retention - b.retention;
  if (a.total !== b.total) return b.total - a.total;
  return a.concept.localeCompare(b.concept);
}

function clearResults(): void {
  env.db.prepare('DELETE FROM recall_results').run();
}

function recordBatch(batch: GenResult[]): void {
  for (const b of batch) {
    const r = recordRecallResult(env.db, {
      concept: b.concept,
      correct: b.correct,
      testedAt: `2026-04-08T${String(b.hour).padStart(2, '0')}:00:00.000Z`,
    });
    if (!r.ok) throw r.error;
  }
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('retention — property invariants', () => {
  it('report aggregates are internally consistent with the raw batch', () => {
    fc.assert(
      fc.property(batchArb, (batch) => {
        clearResults();
        recordBatch(batch);
        const r = getRetentionReport(env.db, { topN: 3, minSampleSize: 1 });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const rep = r.value;

        expect(rep.totalAnswers).toBe(batch.length);
        expect(rep.totalCorrect).toBe(batch.filter((b) => b.correct).length);
        expect(rep.conceptCount).toBe(new Set(batch.map((b) => b.concept)).size);

        expect(rep.overall).toBeGreaterThanOrEqual(0);
        expect(rep.overall).toBeLessThanOrEqual(1);
        if (rep.totalAnswers === 0) expect(rep.overall).toBe(0);
        else expect(rep.overall).toBeCloseTo(rep.totalCorrect / rep.totalAnswers, 10);
      }),
      { numRuns: 200 },
    );
  });

  it('every concept retention is a valid ratio in [0, 1]', () => {
    fc.assert(
      fc.property(batchArb, (batch) => {
        clearResults();
        recordBatch(batch);
        const r = getRetentionReport(env.db, { topN: 5, minSampleSize: 1 });
        if (!r.ok) throw r.error;
        for (const c of [...r.value.weakest, ...r.value.strongest]) {
          expect(c.total).toBeGreaterThanOrEqual(1);
          expect(c.correct).toBeGreaterThanOrEqual(0);
          expect(c.correct).toBeLessThanOrEqual(c.total);
          expect(c.retention).toBeGreaterThanOrEqual(0);
          expect(c.retention).toBeLessThanOrEqual(1);
          expect(c.retention).toBeCloseTo(c.correct / c.total, 10);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('weakest is sorted ascending, strongest descending, both bounded by topN', () => {
    fc.assert(
      fc.property(batchArb, fc.integer({ min: 1, max: 5 }), (batch, topN) => {
        clearResults();
        recordBatch(batch);
        const r = getRetentionReport(env.db, { topN, minSampleSize: 1 });
        if (!r.ok) throw r.error;
        const { weakest, strongest } = r.value;

        expect(weakest.length).toBeLessThanOrEqual(topN);
        expect(strongest.length).toBeLessThanOrEqual(topN);
        for (let i = 1; i < weakest.length; i += 1) {
          expect(weakCmp(weakest[i - 1]!, weakest[i]!)).toBeLessThanOrEqual(0);
        }
        // strongest uses the inverse retention ordering (descending)
        for (let i = 1; i < strongest.length; i += 1) {
          const a = strongest[i - 1]!;
          const b = strongest[i]!;
          expect(a.retention).toBeGreaterThanOrEqual(b.retention);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('getRetentionByConcept matches the batch and is null for unseen concepts', () => {
    fc.assert(
      fc.property(batchArb, (batch) => {
        clearResults();
        recordBatch(batch);
        for (const concept of new Set(batch.map((b) => b.concept))) {
          const r = getRetentionByConcept(env.db, concept);
          if (!r.ok) throw r.error;
          const rows = batch.filter((b) => b.concept === concept);
          const correct = rows.filter((b) => b.correct).length;
          expect(r.value).not.toBeNull();
          expect(r.value!.total).toBe(rows.length);
          expect(r.value!.correct).toBe(correct);
          expect(r.value!.retention).toBeCloseTo(correct / rows.length, 10);
        }
        const unseen = getRetentionByConcept(env.db, 'never-seen-zzz');
        if (!unseen.ok) throw unseen.error;
        expect(unseen.value).toBeNull();
      }),
      { numRuns: 150 },
    );
  });

  it('getWeakAreas respects limit + minSampleSize, sorts ascending, and is deterministic', () => {
    fc.assert(
      fc.property(
        batchArb,
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        (batch, limit, minSampleSize) => {
          clearResults();
          recordBatch(batch);
          const r1 = getWeakAreas(env.db, { limit, minSampleSize });
          const r2 = getWeakAreas(env.db, { limit, minSampleSize });
          if (!r1.ok || !r2.ok) throw new Error('getWeakAreas failed');

          expect(r1.value.length).toBeLessThanOrEqual(limit);
          for (const c of r1.value) {
            expect(c.total).toBeGreaterThanOrEqual(minSampleSize);
          }
          for (let i = 1; i < r1.value.length; i += 1) {
            expect(weakCmp(r1.value[i - 1]!, r1.value[i]!)).toBeLessThanOrEqual(0);
          }
          expect(r1.value).toEqual(r2.value);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('getWeakAreas maxRetention never returns a concept above the threshold', () => {
    fc.assert(
      fc.property(batchArb, fc.float({ min: 0, max: 1, noNaN: true }), (batch, maxRetention) => {
        clearResults();
        recordBatch(batch);
        const r = getWeakAreas(env.db, { limit: 100, maxRetention });
        if (!r.ok) throw r.error;
        for (const c of r.value) {
          expect(c.retention).toBeLessThanOrEqual(maxRetention);
        }
      }),
      { numRuns: 150 },
    );
  });
});
