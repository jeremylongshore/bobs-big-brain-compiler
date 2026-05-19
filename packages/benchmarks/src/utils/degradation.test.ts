/**
 * Tests for the 3× degradation gate (E10-B06).
 *
 * The gate takes per-unit costs (not raw bench medians) so the call
 * site decides how to derive per-unit from whatever bench shape it has.
 * See the comment on DegradationInputSample.
 */

import { describe, expect, it } from 'vitest';

import { computeDegradation, formatDegradation } from './degradation.js';

describe('computeDegradation', () => {
  it('passes when per-unit cost is identical at both scales (ratio = 1)', () => {
    const d = computeDegradation({
      scenario: 'ingest',
      moderate: { unitCount: 50, perUnitMs: 10 },
      large: { unitCount: 500, perUnitMs: 10 },
    });
    expect(d.ratio).toBe(1);
    expect(d.passed).toBe(true);
  });

  it('passes when ratio sits right at the cap', () => {
    const d = computeDegradation({
      scenario: 'lint',
      moderate: { unitCount: 30, perUnitMs: 1 },
      large: { unitCount: 300, perUnitMs: 3 },
    });
    expect(d.ratio).toBe(3);
    expect(d.passed).toBe(true);
  });

  it('fails when ratio exceeds the default 3× cap', () => {
    const d = computeDegradation({
      scenario: 'ingest',
      moderate: { unitCount: 50, perUnitMs: 1 },
      large: { unitCount: 500, perUnitMs: 4 },
    });
    expect(d.ratio).toBe(4);
    expect(d.passed).toBe(false);
  });

  it('honors a custom maxRatio threshold', () => {
    const d = computeDegradation({
      scenario: 'lint',
      moderate: { unitCount: 10, perUnitMs: 1 },
      large: { unitCount: 100, perUnitMs: 2 },
      maxRatio: 1.5,
    });
    expect(d.ratio).toBe(2);
    expect(d.passed).toBe(false);
  });

  it('reports Infinity ratio + fail when moderate perUnitMs is 0', () => {
    const d = computeDegradation({
      scenario: 'broken',
      moderate: { unitCount: 50, perUnitMs: 0 },
      large: { unitCount: 500, perUnitMs: 1 },
    });
    expect(d.ratio).toBe(Infinity);
    expect(d.passed).toBe(false);
  });

  it('passes when both moderate and large are faster than the cap allows', () => {
    // The system getting faster at scale (e.g. cache amortisation) is
    // a healthy sign, not a degradation. ratio < 1 always passes.
    const d = computeDegradation({
      scenario: 'ingest',
      moderate: { unitCount: 50, perUnitMs: 12 },
      large: { unitCount: 500, perUnitMs: 8 },
    });
    expect(d.ratio).toBeLessThan(1);
    expect(d.passed).toBe(true);
  });

  it('echoes inputs back on the result so the JSON record is self-describing', () => {
    const args = {
      scenario: 'compile',
      moderate: { unitCount: 3, perUnitMs: 670 },
      large: { unitCount: 30, perUnitMs: 830 },
      maxRatio: 2.5,
    };
    const d = computeDegradation(args);
    expect(d.scenario).toBe('compile');
    expect(d.moderate).toEqual(args.moderate);
    expect(d.large).toEqual(args.large);
    expect(d.maxRatio).toBe(2.5);
  });
});

describe('formatDegradation', () => {
  it('produces a PASS line for a ratio under the cap', () => {
    const line = formatDegradation(
      computeDegradation({
        scenario: 'ingest',
        moderate: { unitCount: 50, perUnitMs: 10 },
        large: { unitCount: 500, perUnitMs: 12 },
      }),
    );
    expect(line).toMatch(/^PASS/);
    expect(line).toContain('ingest');
    expect(line).toMatch(/moderate\(50\)/);
    expect(line).toMatch(/large\(500\)/);
    expect(line).toMatch(/ratio=\d+\.\d{2}/);
  });

  it('produces a FAIL line when the cap is exceeded', () => {
    const line = formatDegradation(
      computeDegradation({
        scenario: 'lint',
        moderate: { unitCount: 30, perUnitMs: 1 },
        large: { unitCount: 300, perUnitMs: 10 },
      }),
    );
    expect(line).toMatch(/^FAIL/);
    expect(line).toContain('lint');
  });
});
