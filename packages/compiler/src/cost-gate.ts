/**
 * Governed-freshness cost gate (bead `compile-then-govern-e06.5`; risk
 * 010-AT-RISK R12; umbrella #27).
 *
 * The on-push freshness win (recompile only affected pages) is only safe if it
 * cannot burn an unbounded inference budget. A full corpus compile is $50–200;
 * on-push at ~40 pushes/day is unbudgeted. R12 requires the cost model to OUTPUT
 * AN ENFORCEABLE CEILING and a DEBOUNCE/COALESCING WINDOW — not merely an
 * estimate — and to price on the LIVE provider (DeepSeek), not the `.env`
 * `anthropic` default that is ~50× more expensive.
 *
 * This module is that gate. It is deterministic and model-free: it prices a
 * proposed incremental compile from the affected-page set + historical per-type
 * token averages, checks the projection against a per-UTC-day ceiling already
 * spent, and coalesces triggers that arrive inside a debounce window. It never
 * calls an LLM and never mutates durable state; the caller decides what to do
 * with the verdict (proceed / defer to nightly / coalesce).
 *
 * ## Pricing basis (R12 — DeepSeek, not Anthropic)
 *
 * Cost is computed via {@link calculateCost} against {@link MODEL_PRICING},
 * keyed on the model tag the compile will actually write. The live provider is
 * DeepSeek (`ICO_PROVIDER=deepseek`, default model `deepseek-chat`; the live
 * brain currently tags rows `deepseek-v4-flash`). DeepSeek `deepseek-chat`
 * bills ~$0.28 / 1M input and ~$0.42 / 1M output — roughly 50× cheaper than
 * Sonnet's $3 / $15. `calculateCost` falls back to Sonnet pricing only for an
 * UNKNOWN model tag, which would OVER-estimate (fail safe: a compile is more
 * likely to be gated, never silently under-priced). To keep the DeepSeek figure
 * honest for any DeepSeek-family tag not literally `deepseek-chat` (e.g.
 * `deepseek-v4-flash`), {@link resolvePricingModel} maps any `deepseek*` tag to
 * `deepseek-chat` pricing.
 *
 * ## Token projection
 *
 * A compile's token cost is projected as `sum over affected pages of the
 * historical average `tokens_used` for that page's type` (from the
 * `compilations` table). When a type has no history, a conservative
 * per-type default is used (again biased high, never low). Input/output split
 * follows the same 70/30 heuristic the token-tracker uses.
 *
 * @module cost-gate
 */

import type { Database } from '@ico/kernel';
import { err, ok, type Result } from '@ico/types';

import { calculateCost, MODEL_PRICING } from './token-tracker.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Tunable knobs for the cost gate. All have sane defaults; all overridable. */
export interface CostGateConfig {
  /**
   * Hard ceiling on total inference spend per UTC day, in USD. A compile whose
   * projected cost would push the day's cumulative spend over this ceiling is
   * REFUSED (deferred to nightly). Default: `$1.00/day`.
   *
   * Rationale: at DeepSeek rates a typical incremental compile of a handful of
   * affected pages costs well under a cent, so $1/day comfortably absorbs
   * dozens of on-push compiles while still capping a pathological loop.
   */
  dailyCeilingUsd: number;
  /**
   * Debounce / coalescing window in seconds. Two triggers that arrive within
   * this window of each other collapse into ONE compile — the later trigger is
   * told to coalesce (skip) because the earlier compile already covers the
   * window's changes. Default: `300s` (5 min).
   */
  debounceWindowSeconds: number;
  /**
   * The model tag the compile will write (drives pricing). Defaults to the live
   * provider's default, `deepseek-chat`.
   */
  model: string;
}

/** The default gate config — the "sane defaults" R12 asks for. */
export const DEFAULT_COST_GATE_CONFIG: CostGateConfig = {
  dailyCeilingUsd: 1.0,
  debounceWindowSeconds: 300,
  model: 'deepseek-chat',
};

/**
 * Conservative fallback average `tokens_used` per compilation type, used only
 * when the `compilations` table has NO history for that type. Biased toward the
 * high end of observed live values (summaries ~5k; syntheses far larger) so an
 * unknown-history projection over-estimates rather than under-estimates — a gate
 * must never wave through a compile it cannot price.
 */
const FALLBACK_TOKENS_BY_TYPE: Record<string, number> = {
  summary: 8_000,
  concept: 12_000,
  entity: 12_000,
  topic: 200_000,
  contradiction: 40_000,
  'open-question': 40_000,
};

/** Last-resort default when a type is entirely unknown. High on purpose. */
const FALLBACK_TOKENS_UNKNOWN = 50_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One page's contribution to the projected cost. */
export interface CostLineItem {
  type: string;
  count: number;
  /** Average tokens per page of this type (historical or fallback). */
  avgTokens: number;
  /** Whether `avgTokens` came from history (`true`) or a fallback (`false`). */
  fromHistory: boolean;
  /** Projected tokens for this line (`count * avgTokens`). */
  projectedTokens: number;
}

/** The verdict returned by {@link evaluateCostGate}. */
export interface CostGateVerdict {
  /** `proceed` — run the compile; `defer` — over ceiling, send to nightly;
   *  `coalesce` — inside the debounce window, an in-flight compile covers it. */
  decision: 'proceed' | 'defer' | 'coalesce';
  /** Human-readable reason, safe to log. */
  reason: string;
  /** Projected cost of THIS compile in USD (DeepSeek-priced). */
  projectedCostUsd: number;
  /** USD already spent this UTC day (from `compilations` rows dated today). */
  spentTodayUsd: number;
  /** `spentTodayUsd + projectedCostUsd` — what the day total WOULD be. */
  projectedDayTotalUsd: number;
  /** The ceiling that was enforced. */
  ceilingUsd: number;
  /** The model tag used for pricing. */
  pricedModel: string;
  /** Per-type breakdown of the projection. */
  lineItems: CostLineItem[];
}

/** Inputs describing the proposed compile. */
export interface CostGateInput {
  /**
   * The affected pages' compilation types (one entry per page to recompile).
   * Typically `affectedSet.affectedPages.map(p => p.type)`.
   */
  affectedTypes: string[];
  /**
   * Epoch-millis of the last compile that actually ran (for debounce). Omit /
   * `null` when no prior compile is known — the debounce check is then skipped.
   */
  lastCompileAtMs?: number | null;
  /** "Now" as epoch-millis. Injected for deterministic tests. Defaults to `Date.now()`. */
  nowMs?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TypeAvgRow {
  type: string;
  avg_tokens: number | null;
  n: number;
}

interface TodaySpendRow {
  model: string;
  total_tokens: number | null;
}

/**
 * Map a model tag to the key used for pricing. Any `deepseek*` family tag
 * (e.g. `deepseek-v4-flash`, `deepseek-chat`) prices at `deepseek-chat` rates so
 * the DeepSeek figure stays honest even for tags not literally in the table.
 * Everything else passes through; `calculateCost` handles unknowns by falling
 * back to Sonnet (an over-estimate — fail safe).
 */
export function resolvePricingModel(model: string): string {
  return model.toLowerCase().startsWith('deepseek') ? 'deepseek-chat' : model;
}

/** Split a total-token figure into (input, output) via the 70/30 heuristic. */
function splitTokens(total: number): { input: number; output: number } {
  const input = Math.round(total * 0.7);
  return { input, output: total - input };
}

/**
 * Cost (USD) of a total-token figure at the given model's DeepSeek-honest rate.
 * Exported so callers can price the historical day-spend consistently.
 */
export function costOfTokens(totalTokens: number, model: string): number {
  const { input, output } = splitTokens(totalTokens);
  return calculateCost(input, output, resolvePricingModel(model));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate the cost gate for a proposed incremental compile.
 *
 * Order of checks (a compile must clear BOTH):
 *   1. Debounce — if `now - lastCompileAtMs < debounceWindowSeconds`, return
 *      `coalesce` (an in-flight/just-ran compile already covers the window;
 *      running again would duplicate work and spend). This is the coalescing of
 *      "N triggers within T minutes into one compile" R12 requires.
 *   2. Ceiling — project this compile's cost, add it to the USD already spent
 *      this UTC day, and if the total would exceed `dailyCeilingUsd`, return
 *      `defer` (send to nightly). Otherwise `proceed`.
 *
 * Deterministic given `(db state, input, config)`; `nowMs` is injectable so the
 * debounce and the UTC-day boundary are testable without wall-clock flakiness.
 *
 * @param db     - Open better-sqlite3 database (for history + today's spend).
 * @param input  - The proposed compile (affected types, last-compile time).
 * @param config - Partial overrides; missing fields fall back to
 *                 {@link DEFAULT_COST_GATE_CONFIG}.
 */
export function evaluateCostGate(
  db: Database,
  input: CostGateInput,
  config?: Partial<CostGateConfig>,
): Result<CostGateVerdict, Error> {
  const cfg: CostGateConfig = { ...DEFAULT_COST_GATE_CONFIG, ...config };
  const nowMs = input.nowMs ?? Date.now();
  const pricedModel = resolvePricingModel(cfg.model);

  if (!Number.isFinite(cfg.dailyCeilingUsd) || cfg.dailyCeilingUsd < 0) {
    return err(
      new Error(`dailyCeilingUsd must be a non-negative number, got ${cfg.dailyCeilingUsd}`),
    );
  }
  if (!Number.isFinite(cfg.debounceWindowSeconds) || cfg.debounceWindowSeconds < 0) {
    return err(
      new Error(
        `debounceWindowSeconds must be a non-negative number, got ${cfg.debounceWindowSeconds}`,
      ),
    );
  }

  // ---- Project this compile's cost from per-type history ------------------
  let historyRows: TypeAvgRow[];
  try {
    historyRows = db
      .prepare<
        [],
        TypeAvgRow
      >(`SELECT type, AVG(tokens_used) AS avg_tokens, COUNT(*) AS n FROM compilations WHERE tokens_used IS NOT NULL GROUP BY type`)
      .all();
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
  const avgByType = new Map<string, number>();
  for (const r of historyRows) {
    if (r.n > 0 && r.avg_tokens !== null && r.avg_tokens > 0) {
      avgByType.set(r.type, r.avg_tokens);
    }
  }

  // Count affected pages per type, then build line items.
  const countByType = new Map<string, number>();
  for (const t of input.affectedTypes) {
    countByType.set(t, (countByType.get(t) ?? 0) + 1);
  }
  const lineItems: CostLineItem[] = [];
  let projectedTokens = 0;
  for (const [type, count] of Array.from(countByType.entries()).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    const histAvg = avgByType.get(type);
    const fromHistory = histAvg !== undefined;
    const avgTokens = histAvg ?? FALLBACK_TOKENS_BY_TYPE[type] ?? FALLBACK_TOKENS_UNKNOWN;
    const lineTokens = count * avgTokens;
    projectedTokens += lineTokens;
    lineItems.push({
      type,
      count,
      avgTokens: Math.round(avgTokens),
      fromHistory,
      projectedTokens: Math.round(lineTokens),
    });
  }
  const projectedCostUsd = costOfTokens(projectedTokens, cfg.model);

  // ---- Today's spend (UTC) from compilations dated today ------------------
  const utcDay = new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD
  let spendRows: TodaySpendRow[];
  try {
    spendRows = db
      .prepare<[string], TodaySpendRow>(
        `SELECT model, SUM(tokens_used) AS total_tokens
           FROM compilations
          WHERE tokens_used IS NOT NULL AND substr(compiled_at, 1, 10) = ?
          GROUP BY model`,
      )
      .all(utcDay);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
  let spentTodayUsd = 0;
  for (const r of spendRows) {
    if (r.total_tokens !== null && r.total_tokens > 0) {
      // Price each model's tokens at ITS OWN rate (DeepSeek-honest per tag).
      spentTodayUsd += costOfTokens(r.total_tokens, r.model);
    }
  }

  const projectedDayTotalUsd = spentTodayUsd + projectedCostUsd;

  const base = {
    projectedCostUsd,
    spentTodayUsd,
    projectedDayTotalUsd,
    ceilingUsd: cfg.dailyCeilingUsd,
    pricedModel,
    lineItems,
  };

  // ---- Check 1: debounce / coalescing -------------------------------------
  if (input.lastCompileAtMs != null && cfg.debounceWindowSeconds > 0) {
    const elapsedSeconds = (nowMs - input.lastCompileAtMs) / 1000;
    if (elapsedSeconds >= 0 && elapsedSeconds < cfg.debounceWindowSeconds) {
      return ok({
        decision: 'coalesce',
        reason:
          `Coalesced: a compile ran ${elapsedSeconds.toFixed(0)}s ago, inside the ` +
          `${cfg.debounceWindowSeconds}s debounce window. This trigger's changes are covered ` +
          `by the in-flight/just-completed compile.`,
        ...base,
      });
    }
  }

  // ---- Check 2: daily ceiling ---------------------------------------------
  if (projectedDayTotalUsd > cfg.dailyCeilingUsd) {
    return ok({
      decision: 'defer',
      reason:
        `Deferred to nightly: projected day total $${projectedDayTotalUsd.toFixed(4)} ` +
        `(spent $${spentTodayUsd.toFixed(4)} + this compile $${projectedCostUsd.toFixed(4)}) ` +
        `exceeds the $${cfg.dailyCeilingUsd.toFixed(2)}/UTC-day ceiling.`,
      ...base,
    });
  }

  // Nothing to do — an empty affected set is a no-op proceed (projected $0).
  return ok({
    decision: 'proceed',
    reason:
      lineItems.length === 0
        ? 'Proceed: no affected pages (no-op).'
        : `Proceed: projected $${projectedCostUsd.toFixed(4)} keeps the day total at ` +
          `$${projectedDayTotalUsd.toFixed(4)}, under the $${cfg.dailyCeilingUsd.toFixed(2)} ceiling.`,
    ...base,
  });
}

/** Re-export so callers can build a config without importing the token-tracker. */
export { MODEL_PRICING };
