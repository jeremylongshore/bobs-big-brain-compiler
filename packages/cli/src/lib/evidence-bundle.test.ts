import { describe, expect, it, vi } from 'vitest';

import type { EvalBatchResult, EvalResult, EvalSpec } from '@ico/kernel';

import {
  buildAndValidateEvidenceBundle,
  buildEvidenceBundle,
  deterministicUuidV7,
  type EmitOptions,
  serializeEvidenceBundle,
} from './evidence-bundle.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const smokeSpec: EvalSpec = {
  id: 'smoke-audit-chain-intact',
  name: 'Audit chain intact',
  type: 'smoke',
  check: 'audit-chain-intact',
};

function result(over: Partial<EvalResult> = {}): EvalResult {
  return {
    spec: smokeSpec,
    passed: true,
    score: 1,
    threshold: 1,
    details: 'incidental prose that varies between runs',
    durationMs: 7,
    ...over,
  };
}

function batch(results: EvalResult[]): EvalBatchResult {
  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
    durationMs: 10,
  };
}

const OPTS: EmitOptions = {
  createdAt: '2026-06-02T00:00:00.000Z',
  bundleId: deterministicUuidV7(Date.parse('2026-06-02T00:00:00.000Z'), 'bundle:seed'),
  evalRunId: deterministicUuidV7(Date.parse('2026-06-02T00:00:00.000Z'), 'run:seed'),
};

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUBJECT_NAME_RE =
  /^[a-z0-9][a-z0-9-]*:(client|server|ci|sandbox|local):[a-zA-Z0-9][a-zA-Z0-9.-]*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// deterministicUuidV7
// ---------------------------------------------------------------------------

describe('deterministicUuidV7', () => {
  it('produces a structurally valid UUIDv7', () => {
    expect(deterministicUuidV7(Date.parse('2026-06-02T00:00:00.000Z'), 'x')).toMatch(UUIDV7_RE);
  });

  it('is deterministic for the same (timestamp, seed)', () => {
    const a = deterministicUuidV7(1_000_000, 'seed-a');
    const b = deterministicUuidV7(1_000_000, 'seed-a');
    expect(a).toBe(b);
  });

  it('differs when the seed differs', () => {
    expect(deterministicUuidV7(1_000_000, 'seed-a')).not.toBe(
      deterministicUuidV7(1_000_000, 'seed-b'),
    );
  });
});

// ---------------------------------------------------------------------------
// buildEvidenceBundle
// ---------------------------------------------------------------------------

describe('buildEvidenceBundle', () => {
  it('builds a bundle with one subject per result', () => {
    const b = buildEvidenceBundle(
      batch([result(), result({ spec: { ...smokeSpec, id: 'two' } })]),
      OPTS,
    );
    expect(b.subject_set).toHaveLength(2);
  });

  it('names subjects as <tool>:local:<gate-id> matching the kernel pattern', () => {
    const b = buildEvidenceBundle(batch([result()]), OPTS);
    expect(b.subject_set[0]?.name).toBe('ico-eval:local:smoke-audit-chain-intact');
    expect(b.subject_set[0]?.name).toMatch(SUBJECT_NAME_RE);
  });

  it('declares NO predicate URI (reserved, not declared)', () => {
    const b = buildEvidenceBundle(batch([result()]), OPTS);
    expect(b.predicate_uri_set).toEqual([]);
  });

  it('marks the bundle unsigned at emission', () => {
    const b = buildEvidenceBundle(batch([result()]), OPTS);
    expect(b.signing_mode).toBe('unsigned_experimental');
    expect(b.verification_status).toBe('unverified');
    expect(b.rekor_log_indices).toEqual([]);
  });

  it('emits valid UUIDv7 ids', () => {
    const b = buildEvidenceBundle(batch([result()]), OPTS);
    expect(b.id).toMatch(UUIDV7_RE);
    expect(b.eval_run_id).toMatch(UUIDV7_RE);
  });

  it('subject digest is sha256-shaped', () => {
    const b = buildEvidenceBundle(batch([result()]), OPTS);
    expect(b.subject_set[0]?.digest.sha256).toMatch(SHA256_RE);
  });

  it('digest hashes the verdict, NOT the run-varying details prose', () => {
    // Same verdict, different details → identical digest.
    const a = buildEvidenceBundle(batch([result({ details: 'first run: 11 trace events' })]), OPTS);
    const b = buildEvidenceBundle(
      batch([result({ details: 'second run: 13 trace events' })]),
      OPTS,
    );
    expect(a.subject_set[0]?.digest.sha256).toBe(b.subject_set[0]?.digest.sha256);
  });

  it('digest changes when the verdict changes', () => {
    const passed = buildEvidenceBundle(batch([result({ passed: true, score: 1 })]), OPTS);
    const failed = buildEvidenceBundle(batch([result({ passed: false, score: 0 })]), OPTS);
    expect(passed.subject_set[0]?.digest.sha256).not.toBe(failed.subject_set[0]?.digest.sha256);
  });

  it('sanitizes a spec id with illegal chars into a valid gate-id', () => {
    const b = buildEvidenceBundle(
      batch([result({ spec: { ...smokeSpec, id: 'weird id/with:colons' } })]),
      OPTS,
    );
    expect(b.subject_set[0]?.name).toMatch(SUBJECT_NAME_RE);
  });
});

// ---------------------------------------------------------------------------
// serializeEvidenceBundle
// ---------------------------------------------------------------------------

describe('serializeEvidenceBundle', () => {
  it('round-trips and preserves nested subject keys (regression: replacer dropped them)', () => {
    const b = buildEvidenceBundle(batch([result()]), OPTS);
    const parsed = JSON.parse(serializeEvidenceBundle(b)) as {
      subject_set: Array<{ name: string; digest: { sha256: string } }>;
    };
    expect(parsed.subject_set[0]?.name).toBe('ico-eval:local:smoke-audit-chain-intact');
    expect(parsed.subject_set[0]?.digest.sha256).toMatch(SHA256_RE);
  });

  it('is byte-identical for identical input (deterministic)', () => {
    const b = buildEvidenceBundle(batch([result()]), OPTS);
    expect(serializeEvidenceBundle(b)).toBe(serializeEvidenceBundle(b));
  });

  it('ends with a trailing newline', () => {
    expect(serializeEvidenceBundle(buildEvidenceBundle(batch([result()]), OPTS))).toMatch(/\n$/);
  });
});

// ---------------------------------------------------------------------------
// buildAndValidateEvidenceBundle — conformance to the kernel validator
// ---------------------------------------------------------------------------

describe('buildAndValidateEvidenceBundle', () => {
  it('produces a bundle that conforms to @intentsolutions/core (no throw)', async () => {
    const b = await buildAndValidateEvidenceBundle(batch([result()]), OPTS);
    expect(b.subject_set[0]?.name).toMatch(SUBJECT_NAME_RE);
    expect(b.id).toMatch(UUIDV7_RE);
  });

  it('validates an empty batch (zero subjects)', async () => {
    const b = await buildAndValidateEvidenceBundle(batch([]), OPTS);
    expect(b.subject_set).toEqual([]);
  });

  // Regression guard: this function must FAIL CLOSED when the kernel's validator
  // export surface does not match what the adapter expects.
  //
  // It previously fell through to "structural acceptance" in that case, so a
  // function named buildAndVALIDATEEvidenceBundle would return an UNVALIDATED
  // bundle with no signal anywhere. The trigger is a kernel-version mismatch,
  // which was live: this package was pinned at `^0.1.1` while the kernel shipped
  // 0.10.0, and a caret range on a 0.x major caps at 0.1.x.
  //
  // The mock replaces the kernel module for this test only, so we assert the
  // refusal without needing to install an incompatible kernel.
  it('refuses to emit a bundle when the kernel exposes no usable schema', async () => {
    vi.resetModules();
    vi.doMock('@intentsolutions/core/validators/v1', () => ({
      // Deliberately no usable schema. Both names are declared-but-undefined
      // rather than absent, because vitest's mock proxy THROWS on access to an
      // undeclared export, whereas a real ESM namespace yields `undefined` —
      // and `undefined` is the case the production guard has to handle.
      EvidenceBundleSchema: undefined,
      EvidenceBundleV1Schema: undefined,
      SomeUnrelatedSchema: { parse: (x: unknown) => x },
    }));
    const { buildAndValidateEvidenceBundle: isolated } = await import('./evidence-bundle.js');
    await expect(isolated(batch([result()]), OPTS)).rejects.toThrow(
      /Evidence Bundle validation unavailable/,
    );
    vi.doUnmock('@intentsolutions/core/validators/v1');
    vi.resetModules();
  });

  // The complement: a schema that IS present must actually be invoked, not merely
  // looked up. Without this, the guard above could be satisfied by a no-op.
  it('actually calls the kernel schema parse (validation is not skipped)', async () => {
    vi.resetModules();
    let parsed = 0;
    vi.doMock('@intentsolutions/core/validators/v1', () => ({
      EvidenceBundleSchema: {
        parse: (x: unknown) => {
          parsed += 1;
          return x;
        },
      },
    }));
    const { buildAndValidateEvidenceBundle: isolated } = await import('./evidence-bundle.js');
    await isolated(batch([result()]), OPTS);
    expect(parsed).toBe(1);
    vi.doUnmock('@intentsolutions/core/validators/v1');
    vi.resetModules();
  });
});
