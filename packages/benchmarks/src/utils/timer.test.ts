/**
 * Tests for the bench timing utility (E10-B06).
 */

import { describe, expect, it } from 'vitest';

import { bench, formatBenchResult } from './timer.js';

describe('bench', () => {
  it('runs fn exactly once by default and reports a single sample', async () => {
    let calls = 0;
    const r = await bench('one-shot', () => {
      calls += 1;
    });
    expect(calls).toBe(1);
    expect(r.samplesMs).toHaveLength(1);
    expect(r.medianMs).toBe(r.minMs);
    expect(r.medianMs).toBe(r.maxMs);
  });

  it('runs warmup iterations without recording them', async () => {
    let calls = 0;
    const r = await bench(
      'warm',
      () => {
        calls += 1;
      },
      { iterations: 3, warmup: 2 },
    );
    expect(calls).toBe(5); // 2 warmup + 3 measured
    expect(r.samplesMs).toHaveLength(3);
  });

  it('returns the median of multiple samples', async () => {
    // Force ordered durations by sleeping. 10/20/30ms → median 20.
    const durations = [10, 20, 30];
    let idx = 0;
    const r = await bench(
      'median',
      async () => {
        const ms = durations[idx]!;
        idx += 1;
        await new Promise<void>((res) => setTimeout(res, ms));
      },
      { iterations: 3 },
    );
    // Allow generous tolerance — setTimeout is approximate, GC can drift.
    expect(r.medianMs).toBeGreaterThan(15);
    expect(r.medianMs).toBeLessThan(60);
    expect(r.minMs).toBeLessThanOrEqual(r.medianMs);
    expect(r.maxMs).toBeGreaterThanOrEqual(r.medianMs);
  });

  it('captures rss delta as a finite number', async () => {
    const r = await bench('rss', () => {
      // Allocate ~1 MB to nudge RSS — may or may not survive to peak.
      const buf: number[] = [];
      for (let i = 0; i < 100_000; i += 1) buf.push(i);
      return buf.length;
    });
    expect(Number.isFinite(r.rssDeltaMb)).toBe(true);
  });

  it('startedAt is an ISO-8601 timestamp', async () => {
    const r = await bench('iso', () => undefined);
    expect(r.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('rejects iterations < 1', async () => {
    await expect(bench('zero', () => undefined, { iterations: 0 })).rejects.toThrow(
      /iterations must be >= 1/,
    );
  });

  it('rejects negative warmup', async () => {
    await expect(bench('neg', () => undefined, { warmup: -1 })).rejects.toThrow(
      /warmup must be >= 0/,
    );
  });

  it('propagates errors from fn — does not silently average', async () => {
    await expect(
      bench('boom', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('formatBenchResult', () => {
  it('produces a single-line summary with the expected fields', async () => {
    const r = await bench('fmt', () => undefined);
    const line = formatBenchResult(r);
    expect(line).toContain('fmt');
    expect(line).toMatch(/median=\d+\.\dms/);
    expect(line).toMatch(/min=\d+\.\dms/);
    expect(line).toMatch(/max=\d+\.\dms/);
    expect(line).toMatch(/Δrss=-?\d+\.\dMB/);
    expect(line).toContain('n=1');
  });
});
