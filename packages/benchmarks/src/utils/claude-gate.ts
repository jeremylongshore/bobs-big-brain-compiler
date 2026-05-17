/**
 * Claude-gating utility for benchmark scenarios (E10-B06).
 *
 * Scenarios that call the Anthropic API (compile / ask / render) cost
 * real tokens. We only run them when the operator opts in explicitly,
 * so a default `pnpm bench` invocation is free, deterministic, and
 * CI-friendly.
 *
 * Two conditions both have to be true:
 *
 *  1. `ANTHROPIC_API_KEY` is set in the environment.
 *  2. `ICO_BENCH_INCLUDE_CLAUDE=1` is set in the environment.
 *
 * The double gate is intentional. An API key alone is not consent —
 * many developers have it set for normal CLI use. The second var is
 * the explicit "yes, burn tokens on a benchmark run" signal.
 *
 * Skipped scenarios still appear in the JSON output with
 * `skipped: true` and a `skipReason` field so trend-analysis tools can
 * distinguish "didn't run today" from "regressed to zero".
 */

/** Result of the gating check. */
export interface ClaudeGateResult {
  /** True when both gates are satisfied. */
  enabled: boolean;
  /** Human-readable reason when disabled. Empty string when enabled. */
  reason: string;
  /** API key when enabled, undefined otherwise. */
  apiKey?: string;
}

/**
 * Evaluate whether Claude-gated benchmark scenarios may run.
 *
 * Pure function over the environment — read once at the start of a
 * scenario, never poll mid-bench (a flapping result would be impossible
 * to reason about).
 */
export function checkClaudeGate(env: NodeJS.ProcessEnv = process.env): ClaudeGateResult {
  const apiKey = env['ANTHROPIC_API_KEY'];
  const optIn = env['ICO_BENCH_INCLUDE_CLAUDE'];

  if (apiKey === undefined || apiKey === '') {
    return {
      enabled: false,
      reason: 'ANTHROPIC_API_KEY not set',
    };
  }
  if (optIn !== '1') {
    return {
      enabled: false,
      reason: 'ICO_BENCH_INCLUDE_CLAUDE=1 not set (opt-in required to spend tokens)',
    };
  }
  return {
    enabled: true,
    reason: '',
    apiKey,
  };
}
