/**
 * Bench timing utility (E10-B06).
 *
 * Captures wall-clock time and RSS delta around a single async or sync
 * operation. Optionally warms the operation and runs it N times,
 * reporting the median (resistant to GC spikes and one-off cold-start
 * outliers).
 *
 * The numbers this returns are deliberately coarse — we are sizing the
 * 5 operator-visible commands against their second-scale budgets
 * (ingest <2 s, compile <30 s, ask <10 s, render <5 s, lint <30 s), not
 * benchmarking microsecond hot loops. For finer-grained work, drop to
 * `node:perf_hooks` directly.
 */

import { performance } from 'node:perf_hooks';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BenchOptions {
  /** Number of measured iterations. Median is reported. Default 1. */
  iterations?: number;
  /** Number of warm-up iterations (results discarded). Default 0. */
  warmup?: number;
}

export interface BenchResult {
  /** Caller-supplied label. Free-form. */
  label: string;
  /** Median wall-clock duration across `iterations` runs, milliseconds. */
  medianMs: number;
  /** Minimum observed duration, milliseconds. */
  minMs: number;
  /** Maximum observed duration, milliseconds. */
  maxMs: number;
  /** All measured durations in execution order, milliseconds. */
  samplesMs: readonly number[];
  /** Peak RSS delta observed across all measured iterations, megabytes. */
  rssDeltaMb: number;
  /** ISO-8601 timestamp at the start of the first measured iteration. */
  startedAt: string;
}

/**
 * Run `fn` `iterations` times (default 1) after `warmup` discarded runs
 * (default 0), and return median wall-time + RSS delta.
 *
 * The bench treats `fn` as a black box: it does not interpret return
 * values, does not retry on error, and does not aggregate output. A
 * thrown error propagates and aborts the bench — failed benchmarks are
 * better surfaced loudly than averaged silently.
 */
export async function bench<T>(
  label: string,
  fn: () => T | Promise<T>,
  options: BenchOptions = {},
): Promise<BenchResult> {
  const iterations = options.iterations ?? 1;
  const warmup = options.warmup ?? 0;
  if (iterations < 1) {
    throw new Error(`bench: iterations must be >= 1, got ${iterations}`);
  }
  if (warmup < 0) {
    throw new Error(`bench: warmup must be >= 0, got ${warmup}`);
  }

  for (let w = 0; w < warmup; w += 1) {
    await fn();
  }

  const rssBefore = process.memoryUsage.rss();
  const samples: number[] = [];
  const startedAt = new Date().toISOString();
  let rssPeak = rssBefore;

  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await fn();
    const t1 = performance.now();
    samples.push(t1 - t0);
    const rss = process.memoryUsage.rss();
    if (rss > rssPeak) rssPeak = rss;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const rssDeltaMb = (rssPeak - rssBefore) / (1024 * 1024);

  return {
    label,
    medianMs: median,
    minMs: min,
    maxMs: max,
    samplesMs: samples,
    rssDeltaMb,
    startedAt,
  };
}

/**
 * Format a {@link BenchResult} as a single human-readable line for
 * console summaries.
 */
export function formatBenchResult(r: BenchResult): string {
  return (
    `${r.label.padEnd(40)} ` +
    `median=${r.medianMs.toFixed(1)}ms ` +
    `min=${r.minMs.toFixed(1)}ms ` +
    `max=${r.maxMs.toFixed(1)}ms ` +
    `Δrss=${r.rssDeltaMb.toFixed(1)}MB ` +
    `n=${r.samplesMs.length}`
  );
}
