/**
 * 3× degradation gate (E10-B06).
 *
 * The bead's verification clause says:
 *
 *   "Large corpus (500+ sources) completes without failure or
 *    degradation beyond 3× moderate-corpus baseline."
 *
 * In other words: per-unit cost (per source for ingest, per wiki page
 * for lint, etc.) at the large scale must stay within 3× of the
 * moderate-scale per-unit cost. A ratio above 3 indicates super-linear
 * growth — a missing index, an N² walk, a cache that doesn't scale.
 *
 * This module is pure arithmetic. The runner gathers two BenchResults
 * (moderate + large) for a scenario, calls `computeDegradation`, and
 * decides whether to flag the run. We never fail the bench — operators
 * see the flag in stdout + JSON output and file an optimisation bead.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DegradationInputSample {
  /** Total units measured (for record-keeping / context). */
  unitCount: number;
  /**
   * Cost per single unit, milliseconds. The caller computes this from
   * whatever bench shape is appropriate — e.g. for ingest the raw
   * `medianMs` IS per-unit (each iteration was one file), but for
   * lint the median is whole-workspace so per-unit = median / page-count.
   * Putting that decision at the call site (rather than inside the
   * gate) keeps the gate honest: it never has to guess what `medianMs`
   * meant.
   */
  perUnitMs: number;
}

export interface DegradationCheckArgs {
  /** Display name (e.g. "ingest", "lint"). */
  scenario: string;
  /** Moderate-scale measurement (per the bead, ≈50 units). */
  moderate: DegradationInputSample;
  /** Large-scale measurement (per the bead, ≈500 units). */
  large: DegradationInputSample;
  /** Ratio above which the check is flagged as failed. Default 3.0. */
  maxRatio?: number;
}

export interface DegradationCheck {
  scenario: string;
  moderate: DegradationInputSample;
  large: DegradationInputSample;
  /** large.perUnitMs / moderate.perUnitMs. Infinity when moderate is 0. */
  ratio: number;
  /** Threshold used (echoed for record-keeping). */
  maxRatio: number;
  /** True when `ratio <= maxRatio`. */
  passed: boolean;
}

/**
 * Compare per-unit cost at two scales and return the ratio + pass/fail
 * flag. Never throws.
 *
 * A scenario whose moderate per-unit cost is 0 ms gets a ratio of
 * `Infinity` and `passed: false` — a meaningful signal (degenerate
 * baseline) rather than a silent NaN.
 */
export function computeDegradation(args: DegradationCheckArgs): DegradationCheck {
  const maxRatio = args.maxRatio ?? 3.0;
  const ratio =
    args.moderate.perUnitMs > 0 ? args.large.perUnitMs / args.moderate.perUnitMs : Infinity;
  return {
    scenario: args.scenario,
    moderate: args.moderate,
    large: args.large,
    ratio,
    maxRatio,
    passed: ratio <= maxRatio,
  };
}

/**
 * Format a {@link DegradationCheck} as a single human-readable line.
 */
export function formatDegradation(d: DegradationCheck): string {
  const verdict = d.passed ? 'PASS' : 'FAIL';
  return (
    `${verdict} ${d.scenario.padEnd(10)} ` +
    `moderate(${d.moderate.unitCount})=${d.moderate.perUnitMs.toFixed(2)}ms/unit ` +
    `large(${d.large.unitCount})=${d.large.perUnitMs.toFixed(2)}ms/unit ` +
    `ratio=${d.ratio.toFixed(2)} (cap ${d.maxRatio.toFixed(1)})`
  );
}
