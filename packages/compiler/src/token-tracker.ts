/**
 * Token usage tracking and cost calculation for the ICO compiler.
 *
 * Provides cost estimation, cumulative token queries against the compilations
 * table, and display formatting utilities.
 *
 * All functions return `Result<T, Error>` where fallible — never throw.
 */

import type { Database } from '@ico/kernel';
import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Aggregated token usage across all compilations. */
export interface TokenUsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCost: number; // USD
  compilationCount: number;
}

/** Per-model pricing in USD per 1M tokens. */
export interface ModelPricing {
  inputPerMillion: number; // USD per 1M input tokens
  outputPerMillion: number; // USD per 1M output tokens
}

// ---------------------------------------------------------------------------
// Pricing table
// ---------------------------------------------------------------------------

/**
 * Default pricing for common models (USD per 1M tokens).
 *
 * DeepSeek is the LIVE compile + faithfulness-judge provider (teamkb-compile
 * decision: the real eval provider is DeepSeek, auto-selected from
 * `DEEPSEEK_API_KEY`; Anthropic labels route to the stub). Pricing it here —
 * roughly 50× cheaper than Sonnet — is what makes the faithfulness cost model
 * honest: pricing the judge at Anthropic rates was the exact ~50× over-estimate
 * flagged in the e06 risk register (R12), so the judge's cost is reported at
 * DeepSeek rates, not the Anthropic fallback.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-opus-4-6': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-haiku-4-5': { inputPerMillion: 0.8, outputPerMillion: 4 },
  // DeepSeek `deepseek-chat` (deepseek-v3 class) — the previous live provider.
  'deepseek-chat': { inputPerMillion: 0.28, outputPerMillion: 0.42 },
  // MiniMax-M3 — the live provider since 2026-07-31.
  //
  // ⚠️ UNVERIFIED RATE — deliberately biased HIGH, pending confirmation against a
  // real MiniMax invoice. The estate's only written basis is
  // `intent-eval-lab/000-docs/110-AT-SPEC`, which prices M3 as "MiniMax-M3 /
  // DeepSeek-class ... single-digit cents", i.e. an order of magnitude, not a
  // rate card. Rather than invent a precise figure, this entry sits ABOVE
  // DeepSeek (~4x its output rate) and far BELOW the Sonnet fallback (~12x
  // cheaper), which keeps both failure modes bounded:
  //   * it does NOT inherit the ~50x Sonnet over-estimate that an unknown tag
  //     would get, which at the $1.00/day ceiling would start REFUSING on-push
  //     compiles outright;
  //   * it does NOT under-price, preserving this module's "biased high, never
  //     low" contract.
  // Confirm against billing and tighten — see the follow-up bead.
  'MiniMax-M3': { inputPerMillion: 0.3, outputPerMillion: 1.2 },
};

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface TokenSummaryRow {
  compilation_count: number;
  total_tokens: number;
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Calculate the estimated USD cost for a given number of tokens and model.
 *
 * Falls back to `claude-sonnet-4-6` pricing when the model is not found in
 * {@link MODEL_PRICING}.
 *
 * @param inputTokens  - Number of billed input tokens.
 * @param outputTokens - Number of billed output tokens.
 * @param model        - Model identifier string.
 * @returns Estimated cost in USD.
 */
export function calculateCost(inputTokens: number, outputTokens: number, model: string): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING['claude-sonnet-4-6']!;
  return (
    (inputTokens * pricing.inputPerMillion + outputTokens * pricing.outputPerMillion) / 1_000_000
  );
}

/**
 * Query the `compilations` table and return a cumulative {@link TokenUsageSummary}.
 *
 * Because the `compilations` table stores only `tokens_used` (a combined total),
 * input and output tokens are estimated using a 70% / 30% split heuristic.
 *
 * @param db - An open better-sqlite3 database instance.
 * @returns `ok(summary)` on success, or `err(error)` if the query fails.
 */
export function getTokenUsageSummary(db: Database): Result<TokenUsageSummary, Error> {
  try {
    const row = db
      .prepare<[], TokenSummaryRow>(
        `
        SELECT
          COUNT(*) as compilation_count,
          COALESCE(SUM(tokens_used), 0) as total_tokens
        FROM compilations
      `,
      )
      .get();

    if (row === undefined) {
      return err(new Error('Token usage query returned no rows'));
    }

    const totalTokens = row.total_tokens;
    const totalInputTokens = Math.round(totalTokens * 0.7);
    const totalOutputTokens = totalTokens - totalInputTokens;
    const estimatedCost = calculateCost(totalInputTokens, totalOutputTokens, 'claude-sonnet-4-6');

    return ok({
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      estimatedCost,
      compilationCount: row.compilation_count,
    });
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Format token usage as a human-readable string for terminal display.
 *
 * @example
 * formatTokenUsage(863, 371, 'claude-sonnet-4-6')
 * // => "Used 1,234 tokens (~$0.01)"
 *
 * @param inputTokens  - Number of input tokens.
 * @param outputTokens - Number of output tokens.
 * @param model        - Model identifier used for cost lookup.
 * @returns A display string summarising total tokens and estimated cost.
 */
export function formatTokenUsage(inputTokens: number, outputTokens: number, model: string): string {
  const total = inputTokens + outputTokens;
  const cost = calculateCost(inputTokens, outputTokens, model);
  return `Used ${total.toLocaleString()} tokens (~$${cost.toFixed(2)})`;
}
