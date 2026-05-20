/**
 * Tests for token-tracker utilities.
 *
 * Pure function tests (calculateCost, formatTokenUsage) run without a database.
 * DB tests open a fresh `:memory:` database via `initDatabase`, insert fixtures
 * directly, then exercise `getTokenUsageSummary`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, type Database, initDatabase } from '@ico/kernel';

import {
  calculateCost,
  formatTokenUsage,
  getTokenUsageSummary,
  MODEL_PRICING,
} from './token-tracker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a fresh in-memory database with the full ICO schema applied. */
function openDb(): Database {
  const result = initDatabase(':memory:');
  if (!result.ok) throw new Error(`initDatabase failed: ${result.error.message}`);
  return result.value;
}

/**
 * Insert a minimal source row (required as compilations.source_id FK target).
 */
function insertSource(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO sources (id, path, type, ingested_at, hash)
     VALUES (?, ?, 'markdown', '2026-01-01T00:00:00.000Z', ?)`,
  ).run(id, `/raw/${id}.md`, `hash-${id}`);
}

/**
 * Insert a compilation row with optional `tokens_used`.
 */
function insertCompilation(
  db: Database,
  opts: {
    id: string;
    sourceId: string;
    tokensUsed?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, model, tokens_used)
     VALUES (?, ?, 'summary', ?, '2026-01-01T00:00:00.000Z', 'claude-sonnet-4-6', ?)`,
  ).run(opts.id, opts.sourceId, `/wiki/${opts.id}.md`, opts.tokensUsed ?? null);
}

// ---------------------------------------------------------------------------
// calculateCost
// ---------------------------------------------------------------------------

describe('calculateCost', () => {
  it('returns the correct value for the sonnet model', () => {
    // 1000 input + 500 output with sonnet pricing (3/15 per 1M)
    // (1000 * 3 + 500 * 15) / 1_000_000 = (3000 + 7500) / 1_000_000 = 0.0105
    const cost = calculateCost(1000, 500, 'claude-sonnet-4-6');
    expect(cost).toBeCloseTo(0.0105, 10);
  });

  it('returns a higher value for the opus model', () => {
    // opus is 5x input and 5x output pricing vs sonnet
    const sonnetCost = calculateCost(1000, 500, 'claude-sonnet-4-6');
    const opusCost = calculateCost(1000, 500, 'claude-opus-4-6');
    expect(opusCost).toBeGreaterThan(sonnetCost);
  });

  it('falls back to sonnet pricing for an unknown model', () => {
    const unknownCost = calculateCost(1000, 500, 'gpt-99-ultra');
    const sonnetCost = calculateCost(1000, 500, 'claude-sonnet-4-6');
    expect(unknownCost).toBeCloseTo(sonnetCost, 10);
  });

  it('returns zero when both token counts are zero', () => {
    expect(calculateCost(0, 0, 'claude-sonnet-4-6')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatTokenUsage
// ---------------------------------------------------------------------------

describe('formatTokenUsage', () => {
  it('produces a readable string with a dollar amount', () => {
    const result = formatTokenUsage(700, 300, 'claude-sonnet-4-6');
    // Total = 1000, must contain comma-formatted token count and dollar sign
    expect(result).toMatch(/Used 1,000 tokens/);
    expect(result).toMatch(/~\$\d+\.\d{2}/);
  });

  it('uses toLocaleString for large token counts', () => {
    const result = formatTokenUsage(70_000, 30_000, 'claude-sonnet-4-6');
    expect(result).toMatch(/100,000/);
  });

  it('rounds cost to two decimal places', () => {
    const result = formatTokenUsage(1, 1, 'claude-sonnet-4-6');
    // Cost will be extremely small, should still format as $0.00
    expect(result).toMatch(/~\$0\.00/);
  });
});

// ---------------------------------------------------------------------------
// getTokenUsageSummary
// ---------------------------------------------------------------------------

describe('getTokenUsageSummary', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb();
  });
  afterEach(() => {
    closeDatabase(db);
  });

  it('returns zeros when there are no compilations', () => {
    const result = getTokenUsageSummary(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.compilationCount).toBe(0);
    expect(result.value.totalTokens).toBe(0);
    expect(result.value.totalInputTokens).toBe(0);
    expect(result.value.totalOutputTokens).toBe(0);
    expect(result.value.estimatedCost).toBe(0);
  });

  it('returns correct totals when compilations exist', () => {
    insertSource(db, 'src-1');
    insertSource(db, 'src-2');
    insertCompilation(db, { id: 'c-1', sourceId: 'src-1', tokensUsed: 1000 });
    insertCompilation(db, { id: 'c-2', sourceId: 'src-2', tokensUsed: 500 });

    const result = getTokenUsageSummary(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.compilationCount).toBe(2);
    expect(result.value.totalTokens).toBe(1500);
    // 70% input heuristic: Math.round(1500 * 0.7) = 1050
    expect(result.value.totalInputTokens).toBe(1050);
    // remaining: 1500 - 1050 = 450
    expect(result.value.totalOutputTokens).toBe(450);
    expect(result.value.estimatedCost).toBeGreaterThan(0);
  });

  it('treats NULL tokens_used as zero in the sum', () => {
    insertSource(db, 'src-1');
    insertCompilation(db, { id: 'c-1', sourceId: 'src-1', tokensUsed: null });

    const result = getTokenUsageSummary(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.compilationCount).toBe(1);
    expect(result.value.totalTokens).toBe(0);
  });

  it('uses sonnet pricing for the cost estimate', () => {
    insertSource(db, 'src-1');
    // 1M tokens total → 700k input + 300k output at sonnet rates
    // cost = (700000 * 3 + 300000 * 15) / 1_000_000 = (2100000 + 4500000) / 1_000_000 = 6.6
    insertCompilation(db, { id: 'c-1', sourceId: 'src-1', tokensUsed: 1_000_000 });

    const result = getTokenUsageSummary(db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedCost = calculateCost(700_000, 300_000, 'claude-sonnet-4-6');
    expect(result.value.estimatedCost).toBeCloseTo(expectedCost, 8);
  });
});

// ---------------------------------------------------------------------------
// MODEL_PRICING export
// ---------------------------------------------------------------------------

describe('MODEL_PRICING', () => {
  it('exports pricing for the three canonical models', () => {
    expect(MODEL_PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(MODEL_PRICING['claude-opus-4-6']).toBeDefined();
    expect(MODEL_PRICING['claude-haiku-4-5']).toBeDefined();
  });
});
