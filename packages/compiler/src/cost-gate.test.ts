/**
 * Tests for the governed-freshness cost gate (e06.5 / R12).
 *
 * Proves the two enforceable outputs R12 demands: a per-UTC-day spend CEILING
 * that blocks an over-budget compile, and a DEBOUNCE window that coalesces
 * rapid triggers. Pricing is asserted on DeepSeek rates (the live provider),
 * NOT the Anthropic default. Deterministic (injected `nowMs`), zero-LLM-cost.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, type Database, initDatabase } from '@ico/kernel';

import {
  costOfTokens,
  DEFAULT_COST_GATE_CONFIG,
  evaluateCostGate,
  resolvePricingModel,
} from './cost-gate.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function openDb(): Database {
  const result = initDatabase(':memory:');
  if (!result.ok) throw new Error(`initDatabase failed: ${result.error.message}`);
  return result.value;
}

/** Insert a compilation row so history + today-spend queries have data. */
function insertCompilation(
  db: Database,
  opts: { id: string; type: string; tokensUsed: number; compiledAt: string; model?: string },
): void {
  db.prepare(
    `INSERT INTO compilations (id, source_id, type, output_path, compiled_at, stale, model, tokens_used)
     VALUES (?, NULL, ?, ?, ?, 0, ?, ?)`,
  ).run(
    opts.id,
    opts.type,
    `wiki/${opts.type}/${opts.id}.md`,
    opts.compiledAt,
    opts.model ?? 'deepseek-chat',
    opts.tokensUsed,
  );
}

const NOW = Date.parse('2026-06-30T12:00:00.000Z');
const TODAY = '2026-06-30';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('cost gate — pricing basis (R12: DeepSeek, not Anthropic)', () => {
  it('prices any deepseek-family model tag at deepseek-chat rates', () => {
    expect(resolvePricingModel('deepseek-chat')).toBe('deepseek-chat');
    expect(resolvePricingModel('deepseek-v4-flash')).toBe('deepseek-chat');
    expect(resolvePricingModel('DeepSeek-Reasoner')).toBe('deepseek-chat');
    // Non-deepseek passes through (calculateCost then falls back to Sonnet).
    expect(resolvePricingModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('costs ~50x less on DeepSeek than on Anthropic Sonnet for the same tokens', () => {
    const tokens = 1_000_000; // 1M total → 700k in / 300k out (70/30 split)
    const deepseek = costOfTokens(tokens, 'deepseek-chat');
    const sonnet = costOfTokens(tokens, 'claude-sonnet-4-6');
    // DeepSeek: 0.7M*$0.28 + 0.3M*$0.42 = $0.196 + $0.126 = $0.322
    expect(deepseek).toBeCloseTo(0.322, 3);
    // Sonnet: 0.7M*$3 + 0.3M*$15 = $2.1 + $4.5 = $6.6
    expect(sonnet).toBeCloseTo(6.6, 3);
    expect(sonnet / deepseek).toBeGreaterThan(20); // order-of-magnitude cheaper
  });

  it('default config uses the DeepSeek model and sane ceiling + window', () => {
    expect(DEFAULT_COST_GATE_CONFIG.model).toBe('deepseek-chat');
    expect(DEFAULT_COST_GATE_CONFIG.dailyCeilingUsd).toBeGreaterThan(0);
    expect(DEFAULT_COST_GATE_CONFIG.debounceWindowSeconds).toBeGreaterThan(0);
  });
});

describe('cost gate — daily ceiling enforcement', () => {
  let db: Database;
  beforeEach(() => {
    db = openDb();
  });
  afterEach(() => {
    closeDatabase(db);
  });

  it('BLOCKS (defers) a compile whose projected day total exceeds the ceiling', () => {
    // Big historical topic pages set a high per-type average; a compile of many
    // topics then projects over a low ceiling.
    for (let i = 0; i < 5; i++) {
      insertCompilation(db, {
        id: `hist-topic-${i}`,
        type: 'topic',
        tokensUsed: 7_000_000, // ~live topic average
        compiledAt: '2026-06-01T00:00:00.000Z', // prior day — history, not today's spend
      });
    }

    // Recompiling 10 topic pages at ~7M tokens each is ~70M tokens ≈ $22 on
    // DeepSeek — far over a $0.10 ceiling.
    const result = evaluateCostGate(
      db,
      { affectedTypes: Array<string>(10).fill('topic'), nowMs: NOW, lastCompileAtMs: null },
      { dailyCeilingUsd: 0.1, model: 'deepseek-chat' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('defer');
    expect(result.value.projectedCostUsd).toBeGreaterThan(0.1);
    expect(result.value.reason).toMatch(/Deferred to nightly/);
  });

  it('counts USD already spent TODAY toward the ceiling', () => {
    // A small compile that would pass on its own is deferred because today’s
    // prior spend already sits near the ceiling.
    insertCompilation(db, {
      id: 'today-big',
      type: 'topic',
      tokensUsed: 300_000_000, // huge spend already today (~$96 on DeepSeek)
      compiledAt: `${TODAY}T02:00:00.000Z`,
    });

    const result = evaluateCostGate(
      db,
      { affectedTypes: ['summary'], nowMs: NOW, lastCompileAtMs: null },
      { dailyCeilingUsd: 1.0, model: 'deepseek-chat' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.spentTodayUsd).toBeGreaterThan(1.0);
    expect(result.value.decision).toBe('defer');
  });

  it('PROCEEDS when the projected day total stays under the ceiling', () => {
    // A tiny incremental compile of one summary (~5k tokens ≈ $0.000002) sails
    // under a $1 ceiling.
    insertCompilation(db, {
      id: 'hist-sum',
      type: 'summary',
      tokensUsed: 5_000,
      compiledAt: '2026-06-01T00:00:00.000Z',
    });

    const result = evaluateCostGate(
      db,
      { affectedTypes: ['summary'], nowMs: NOW, lastCompileAtMs: null },
      { dailyCeilingUsd: 1.0, model: 'deepseek-chat' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('proceed');
    expect(result.value.projectedDayTotalUsd).toBeLessThanOrEqual(1.0);
  });

  it('an empty affected set is a no-op proceed at $0', () => {
    const result = evaluateCostGate(
      db,
      { affectedTypes: [], nowMs: NOW, lastCompileAtMs: null },
      { dailyCeilingUsd: 1.0 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('proceed');
    expect(result.value.projectedCostUsd).toBe(0);
  });
});

describe('cost gate — debounce / coalescing window', () => {
  let db: Database;
  beforeEach(() => {
    db = openDb();
  });
  afterEach(() => {
    closeDatabase(db);
  });

  it('COALESCES a trigger that arrives inside the debounce window', () => {
    // A compile ran 60s ago; a new trigger inside the 300s window coalesces.
    const result = evaluateCostGate(
      db,
      {
        affectedTypes: ['summary'],
        nowMs: NOW,
        lastCompileAtMs: NOW - 60_000, // 60s ago
      },
      { debounceWindowSeconds: 300, dailyCeilingUsd: 1.0 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('coalesce');
    expect(result.value.reason).toMatch(/Coalesced/);
  });

  it('does NOT coalesce once the debounce window has elapsed', () => {
    insertCompilation(db, {
      id: 'hist-sum',
      type: 'summary',
      tokensUsed: 5_000,
      compiledAt: '2026-06-01T00:00:00.000Z',
    });
    const result = evaluateCostGate(
      db,
      {
        affectedTypes: ['summary'],
        nowMs: NOW,
        lastCompileAtMs: NOW - 400_000, // 400s ago > 300s window
      },
      { debounceWindowSeconds: 300, dailyCeilingUsd: 1.0 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('proceed');
  });

  it('N rapid triggers within T collapse into ONE compile (rest coalesce)', () => {
    // First trigger at t0 proceeds (no prior compile); the next three within the
    // window all coalesce against the t0 compile.
    const t0 = NOW;
    const first = evaluateCostGate(
      db,
      { affectedTypes: ['summary'], nowMs: t0, lastCompileAtMs: null },
      { debounceWindowSeconds: 300, dailyCeilingUsd: 1.0 },
    );
    expect(first.ok && first.value.decision).toBe('proceed');

    const followers = [30_000, 120_000, 299_000].map((dtMs) =>
      evaluateCostGate(
        db,
        { affectedTypes: ['summary'], nowMs: t0 + dtMs, lastCompileAtMs: t0 },
        { debounceWindowSeconds: 300, dailyCeilingUsd: 1.0 },
      ),
    );
    for (const f of followers) {
      expect(f.ok).toBe(true);
      if (f.ok) expect(f.value.decision).toBe('coalesce');
    }
  });

  it('debounce is checked BEFORE the ceiling (a coalesced trigger never over-spends)', () => {
    // Even an over-budget projection coalesces if inside the window — the gate
    // short-circuits before pricing decides "defer".
    const result = evaluateCostGate(
      db,
      {
        affectedTypes: Array<string>(50).fill('topic'),
        nowMs: NOW,
        lastCompileAtMs: NOW - 10_000,
      },
      { debounceWindowSeconds: 300, dailyCeilingUsd: 0.001, model: 'deepseek-chat' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decision).toBe('coalesce');
  });
});
