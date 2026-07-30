/**
 * evidence-bundle.ts — emit a canonical Evidence Bundle from an eval run.
 *
 * Maps an `EvalBatchResult` (the output of `ico eval run`) to an Evidence
 * Bundle conforming to @intentsolutions/core's
 * `schemas/v1/evidence-bundle.schema.json`. This is the ICOS side of the
 * platform unification thesis (DR-010 Q3): every validator emits an Evidence
 * Bundle.
 *
 * Scope of THIS module (bead tr08.11): EMISSION only — build + validate + write
 * the bundle JSON. Signing (sigstore / cosign sign-blob → production Rekor) is a
 * separate, deliberate step handled by the platform's sign-evidence-bundle
 * workflow against the emitted file. We do NOT sign here.
 *
 * Honest scoping, carried from the platform's audit-first posture:
 *  - The bundle declares NO predicate URI. `predicate_uri_set` is empty. ICOS's
 *    predicate is not declared — production-Rekor predicate declaration is gated
 *    (DR-010 Q3 + DR-018) on SPEC.md + DNSSEC + CAA at evals.intentsolutions.io,
 *    none cleared. A bundle attests artifact integrity + identity + time, NOT
 *    predicate conformance and NOT that the eval results are "correct".
 *  - `signing_mode` is `unsigned_experimental` until the bundle is actually
 *    signed downstream; the signer flips it.
 */

import { createHash } from 'node:crypto';

import type { EvalBatchResult, EvalResult } from '@ico/kernel';

/**
 * Minimal structural type of the kernel Evidence Bundle (v1). We mirror the
 * required fields from evidence-bundle.schema.json rather than importing a TS
 * type, because the kernel publishes the contract as a JSON Schema + Zod
 * validator; we validate the constructed object against that validator before
 * trusting it (see buildAndValidateEvidenceBundle).
 */
export interface EvidenceBundleV1 {
  id: string;
  eval_run_id: string;
  created_at: string;
  predicate_uri_set: string[];
  row_count: number;
  subject_set: Array<{ name: string; digest: { sha256: string } }>;
  storage_key: string;
  signing_mode: 'sigstore_staging' | 'rekor_production' | 'unsigned_experimental';
  rekor_log_indices: number[];
  verification_status: 'verified' | 'unverified' | 'failed';
  verification_last_checked_at: string;
}

/** Inputs that make the bundle deterministic + reproducible (no Date.now / random inside). */
export interface EmitOptions {
  /** RFC3339 UTC timestamp. Pass a fixed value for reproducible bundles. */
  createdAt: string;
  /** UUIDv7 for the bundle id. */
  bundleId: string;
  /** UUIDv7 for the eval-run id. */
  evalRunId: string;
}

/**
 * Construct a valid UUIDv7 whose entropy bits are DERIVED (not random) from a
 * seed, so the same (timestamp, seed) pair always yields the same id. This keeps
 * emitted bundles reproducible — node's randomUUID is v4-only and the kernel
 * schema requires v7. Layout per RFC 9562: 48-bit unix-ms timestamp, 4-bit
 * version (0111), 12 bits + 2-bit variant (10) + 62 bits, all filled from the
 * seed hash here.
 */
export function deterministicUuidV7(timestampMs: number, seed: string): string {
  const tsHex = Math.max(0, Math.floor(timestampMs)).toString(16).padStart(12, '0').slice(-12);
  const h = createHash('sha256').update(seed).digest('hex'); // 64 hex chars of derived entropy
  // time_low(8) time_mid(4) | ver+rand(4) | variant+rand(4) | rand(12)
  const timeLow = tsHex.slice(0, 8);
  const timeMid = tsHex.slice(8, 12);
  const verAndRand = '7' + h.slice(0, 3); // version 7 nibble + 12 bits derived
  // variant: top two bits = 10 → first nibble ∈ {8,9,a,b}. Force it.
  const variantNibbleVal = (parseInt(h.slice(3, 4), 16) & 0x3) | 0x8;
  const variantAndRand = variantNibbleVal.toString(16) + h.slice(4, 7); // 4 hex
  const tail = h.slice(7, 19); // 12 hex
  return `${timeLow}-${timeMid}-${verAndRand}-${variantAndRand}-${tail}`;
}

const SUBJECT_NAME_RE =
  /^[a-z0-9][a-z0-9-]*:(client|server|ci|sandbox|local):[a-zA-Z0-9][a-zA-Z0-9.-]*$/;

/** Sanitize a spec id into the gate-id segment of a subjectName. */
function gateId(specId: string): string {
  // gate-id segment allows [a-zA-Z0-9][a-zA-Z0-9.-]* — replace anything else with '-'.
  const cleaned = specId.replace(/[^a-zA-Z0-9.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '');
  return cleaned.length > 0 ? cleaned : 'eval';
}

/**
 * Stable SHA-256 of a single result's VERDICT (canonical, sorted-key JSON).
 *
 * Deliberately hashes only the semantic verdict — `{id, type, passed, score,
 * threshold}` — and NOT the free-text `details` blurb. `details` carries
 * incidental, run-varying text (e.g. a cumulative trace-event count) that would
 * churn the digest without any change in the actual eval outcome. The subject
 * digest should change iff the verdict changes, so the bundle is reproducible
 * from the result and the attestation is about the outcome, not the prose.
 */
function resultDigest(r: EvalResult): string {
  const canonical = JSON.stringify({
    id: r.spec.id,
    passed: r.passed,
    score: r.score,
    threshold: r.threshold,
    type: r.spec.type,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Build an Evidence Bundle object from a batch result. Pure + deterministic
 * given EmitOptions — same inputs produce byte-identical output.
 */
export function buildEvidenceBundle(batch: EvalBatchResult, opts: EmitOptions): EvidenceBundleV1 {
  const subject_set = batch.results.map((r) => {
    const name = `ico-eval:local:${gateId(r.spec.id)}`;
    return { name, digest: { sha256: resultDigest(r) } };
  });

  return {
    id: opts.bundleId,
    eval_run_id: opts.evalRunId,
    created_at: opts.createdAt,
    // EMPTY by design — no predicate URI declared (DR-010 Q3 / DR-018).
    predicate_uri_set: [],
    row_count: 0,
    subject_set,
    storage_key: 'git:jeremylongshore/intentional-cognition-os:ico-eval-evidence-bundle',
    // Unsigned at emission; the downstream signer flips this when it signs.
    signing_mode: 'unsigned_experimental',
    rekor_log_indices: [],
    verification_status: 'unverified',
    verification_last_checked_at: opts.createdAt,
  };
}

/**
 * Validate a constructed bundle against the kernel's published v1 validator.
 * Returns the validated bundle or throws with the validation error. Importing
 * the validator lazily keeps the cold-path (no --emit-bundle) free of the dep
 * load.
 */
export async function buildAndValidateEvidenceBundle(
  batch: EvalBatchResult,
  opts: EmitOptions,
): Promise<EvidenceBundleV1> {
  const bundle = buildEvidenceBundle(batch, opts);

  // Cheap structural self-checks before deferring to the kernel validator —
  // gives a clearer error than a deep schema failure.
  for (const s of bundle.subject_set) {
    if (!SUBJECT_NAME_RE.test(s.name)) {
      throw new Error(`Evidence Bundle subject name violates kernel pattern: ${s.name}`);
    }
  }

  // Validate against the canonical kernel validator (source of truth).
  const validators = (await import('@intentsolutions/core/validators/v1')) as Record<
    string,
    unknown
  >;
  // The kernel exposes a Zod schema for the Evidence Bundle under one of two
  // conventional export names. Resolve it, and FAIL CLOSED if neither is present.
  //
  // This used to fall through to "structural acceptance" when the export surface
  // differed — which made a function named buildAndVALIDATEEvidenceBundle return
  // an UNVALIDATED bundle, silently, with no signal at any layer. The local
  // structural checks above cover a subject-name pattern and nothing else; they
  // are not a substitute for the canonical schema and were never sized to be.
  //
  // The trigger for that path is precisely a kernel-version mismatch, which is not
  // hypothetical: this package sat pinned at `^0.1.1` while the kernel shipped
  // 0.10.0, and caret ranges on a 0.x major cap at 0.1.x — so it could never have
  // resolved forward on its own. If a future kernel renames this export, the right
  // outcome is a loud failure telling us to update the adapter, not bundles that
  // quietly stop being checked while still being emitted, signed, and published.
  const schema =
    (validators['EvidenceBundleSchema'] as { parse: (x: unknown) => unknown } | undefined) ??
    (validators['EvidenceBundleV1Schema'] as { parse: (x: unknown) => unknown } | undefined);
  if (!schema || typeof schema.parse !== 'function') {
    throw new Error(
      'Evidence Bundle validation unavailable: @intentsolutions/core/validators/v1 exposes neither ' +
        'EvidenceBundleSchema nor EvidenceBundleV1Schema with a .parse(). Refusing to emit an ' +
        'unvalidated bundle. This usually means the installed kernel version is incompatible with ' +
        'this adapter — check the @intentsolutions/core range in packages/cli/package.json.',
    );
  }
  schema.parse(bundle);
  return bundle;
}

/** Recursively sort object keys so serialization is deterministic at every depth. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Serialize a bundle to canonical, deterministic JSON (recursively sorted keys
 * + trailing newline). NOTE: do not use JSON.stringify's array-replacer form for
 * this — a top-level key allowlist silently drops nested object keys (e.g. the
 * name/digest inside each subject).
 */
export function serializeEvidenceBundle(bundle: EvidenceBundleV1): string {
  return JSON.stringify(sortDeep(bundle), null, 2) + '\n';
}
