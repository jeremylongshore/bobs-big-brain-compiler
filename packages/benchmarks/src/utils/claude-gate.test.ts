/**
 * Tests for the Claude-gating utility (E10-B06).
 */

import { describe, expect, it } from 'vitest';

import { checkClaudeGate } from './claude-gate.js';

describe('checkClaudeGate', () => {
  it('disables when ANTHROPIC_API_KEY is unset', () => {
    const r = checkClaudeGate({ ICO_BENCH_INCLUDE_CLAUDE: '1' });
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/ANTHROPIC_API_KEY/);
    expect(r.apiKey).toBeUndefined();
  });

  it('disables when ANTHROPIC_API_KEY is empty string', () => {
    const r = checkClaudeGate({ ANTHROPIC_API_KEY: '', ICO_BENCH_INCLUDE_CLAUDE: '1' });
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('disables when ICO_BENCH_INCLUDE_CLAUDE is unset (key alone is not consent)', () => {
    const r = checkClaudeGate({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/ICO_BENCH_INCLUDE_CLAUDE/);
  });

  it('disables when ICO_BENCH_INCLUDE_CLAUDE is set to anything other than "1"', () => {
    const r = checkClaudeGate({
      ANTHROPIC_API_KEY: 'sk-test',
      ICO_BENCH_INCLUDE_CLAUDE: 'true',
    });
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/ICO_BENCH_INCLUDE_CLAUDE=1/);
  });

  it('enables only when both gates are satisfied', () => {
    const r = checkClaudeGate({
      ANTHROPIC_API_KEY: 'sk-test',
      ICO_BENCH_INCLUDE_CLAUDE: '1',
    });
    expect(r.enabled).toBe(true);
    expect(r.reason).toBe('');
    expect(r.apiKey).toBe('sk-test');
  });

  it('defaults to reading process.env when no argument passed', () => {
    // Just verify it doesn't throw — we can't assume process.env state.
    const r = checkClaudeGate();
    expect(typeof r.enabled).toBe('boolean');
    expect(typeof r.reason).toBe('string');
  });

  it('reports a specific reason that downstream tooling can parse', () => {
    // The JSON output downstream reads `skipReason` to distinguish
    // "no key" from "opt-in flag missing". The reasons must be stable.
    const noKey = checkClaudeGate({});
    expect(noKey.reason).toContain('ANTHROPIC_API_KEY');
    const noOptIn = checkClaudeGate({ ANTHROPIC_API_KEY: 'sk-test' });
    expect(noOptIn.reason).toContain('ICO_BENCH_INCLUDE_CLAUDE');
  });
});
