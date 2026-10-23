/**
 * Tests for the bench timing utility (E10-B06).
 */

import { performance } from 'node:perf_hooks';

import { describe, expect, it, vi } from 'vitest';

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
    // Unordered durations verify sorting while avoiding scheduler speed bounds.
    const durations = [30, 2, 10];
    let clockMs = 0;
    let calls = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
    try {
      const r = await bench(
        'median',
        async () => {
          const duration = durations[calls++]!;
          // Advance after yielding so measuring without awaiting fn would fail.
          await Promise.resolve();
          clockMs += duration;
        },
        { iterations: durations.length },
      );
      expect(calls).toBe(3);
      expect(r.samplesMs).toEqual([30, 2, 10]);
      expect(r.medianMs).toBe(10);
      expect(r.minMs).toBe(2);
      expect(r.maxMs).toBe(30);
    } finally {
      clock.mockRestore();
    }
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
