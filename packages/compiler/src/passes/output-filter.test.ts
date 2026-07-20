/**
 * Tests for the deterministic model-output filter + pass-provenance stamping
 * (l13.1 / l13.5). Pure predicate + string transforms — no DB, no Claude.
 */

import { describe, expect, it } from 'vitest';

import {
  checkModelOutput,
  COMPILE_PASS_VERSION,
  CompileSkipError,
  DEFAULT_MIN_BODY_CHARS,
  stampPassProvenance,
} from './output-filter.js';

const VALID_PAGE = `---
type: source-summary
id: ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb
title: A Real Page
---

## Summary

This body is comfortably longer than the degenerate-output floor so it passes.`;

describe('checkModelOutput', () => {
  it('accepts a well-formed fenced page with a real body', () => {
    expect(checkModelOutput(VALID_PAGE)).toEqual({ ok: true });
  });

  it('rejects empty / whitespace-only output', () => {
    const r = checkModelOutput('   \n  \t ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe('EMPTY_OUTPUT');
  });

  it.each([
    'I cannot help with that request.',
    "I'm sorry, but as an AI I cannot comply.",
    'As an AI language model, I am unable to do this.',
    "I won't produce that content.",
  ])('rejects refusal boilerplate: %s', (text) => {
    const r = checkModelOutput(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe('REFUSAL_DETECTED');
  });

  it('does NOT trip the refusal filter on a fenced page whose BODY quotes a refusal', () => {
    const page = `---
type: concept
id: 11111111-2222-3333-4444-555555555555
title: Refusal Handling
---

The support agent said "I cannot process this" which the paper analyses at length here.`;
    expect(checkModelOutput(page)).toEqual({ ok: true });
  });

  it('rejects non-markdown junk with no structural signal', () => {
    const r = checkModelOutput(
      'just a blob of prose with no fence, no key line, no heading at all',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe('NON_MARKDOWN_JUNK');
  });

  it('rejects a fenced page whose body is under the floor (Empty Source Document shape)', () => {
    const husk = `---
type: source-summary
id: aaaaaaaa-1111-2222-3333-444444444444
title: Empty Source Document
---

n/a`;
    const r = checkModelOutput(husk);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe('BODY_TOO_SHORT');
  });

  it('honors a custom minBodyChars', () => {
    const r = checkModelOutput(VALID_PAGE, { minBodyChars: 10_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe('BODY_TOO_SHORT');
  });

  it('exposes a sane default floor', () => {
    expect(DEFAULT_MIN_BODY_CHARS).toBeGreaterThan(0);
  });

  it('truncates the excerpt to 120 chars', () => {
    const r = checkModelOutput('x'.repeat(500));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.excerpt.length).toBe(120);
  });
});

describe('stampPassProvenance', () => {
  it('stamps compiled_by + pass_version into existing frontmatter', () => {
    const out = stampPassProvenance(VALID_PAGE, 'compile.summarize');
    expect(out).toContain('compiled_by: compile.summarize');
    expect(out).toContain(`pass_version: ${COMPILE_PASS_VERSION}`);
  });

  it('overwrites model-emitted values with the deterministic ones', () => {
    const withModelValues = `---
type: source-summary
id: 11111111-1111-1111-1111-111111111111
title: t
source_path: raw/model-said-this.md
content_hash: MODELHASH
---

body long enough to clear the floor for this provenance test case here.`;
    const out = stampPassProvenance(withModelValues, 'compile.summarize', {
      source_path: 'raw/real.md',
      content_hash: 'REALHASH',
    });
    expect(out).toContain('source_path: raw/real.md');
    expect(out).toContain('content_hash: REALHASH');
    expect(out).not.toContain('MODELHASH');
    expect(out).not.toContain('model-said-this');
  });

  it('inserts fields absent from the frontmatter', () => {
    const out = stampPassProvenance(VALID_PAGE, 'compile.extract', { source_path: 'raw/x.md' });
    expect(out).toContain('source_path: raw/x.md');
  });
});

describe('CompileSkipError', () => {
  it('carries a machine-readable code and is an Error', () => {
    const e = new CompileSkipError('EMPTY_SOURCE', 'skipped');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('CompileSkipError');
    expect(e.code).toBe('EMPTY_SOURCE');
  });
});
