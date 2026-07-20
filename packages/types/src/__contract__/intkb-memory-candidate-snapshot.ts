/**
 * VENDORED SNAPSHOT — do NOT edit by hand.
 *
 * Byte-equivalent copy of bobs-big-brain-registrar/packages/schema/src/memory-
 * candidate.ts (+ its enum/common dependencies) at commit time of this file.
 * Used ONLY by the contract test to validate that ICO-emitted spool JSONL
 * lines parse successfully through INTKB's actual Zod parser.
 *
 * Why a snapshot rather than a real dependency:
 *   - INTKB is not published to npm (workspace-internal package).
 *   - A `file:` protocol dependency would break in CI environments without
 *     the INTKB checkout alongside.
 *   - Per CTO call in 035-AT-DECR §4.1, ICO mirrors the schema in v1 with
 *     a contract test rather than extracting a third shared package; the
 *     tripwire bead `intentional-cognition-os-ziz.6` fires if the schema
 *     changes more than once after v1 ships, at which point we extract.
 *
 * Resync procedure when INTKB schema changes:
 *   1. Copy the relevant Zod schemas from bobs-big-brain-registrar/packages/
 *      schema/src/ into this file (preserving structure).
 *   2. Run `pnpm test` in @ico/types — the contract test will report any
 *      shape mismatches between ICO's `SpoolMemoryCandidateSchema` and
 *      INTKB's `MemoryCandidate` shape.
 *   3. Update `packages/types/src/spool.ts` to match if mismatch found.
 *   4. Record the resync in IDEA-CHANGELOG.md.
 *
 * Source-of-truth path:
 *   bobs-big-brain-registrar/packages/schema/src/memory-candidate.ts
 *   bobs-big-brain-registrar/packages/schema/src/enums.ts
 *   bobs-big-brain-registrar/packages/schema/src/common.ts
 *
 * Snapshot taken: 2026-05-24 (INTKB v0.6.0).
 * Resynced: 2026-07-19 (GSB Wave-2 H1, registrar branch
 *   feat/h1-h5-origin-token-schema). Deltas folded in since v0.6.0:
 *   - `schemaVersion` is now PART of INTKB's schema (pinned literal '1' with
 *     default — a future ICO v2 line FAILS safeParse instead of being
 *     silently stripped; 5bm.6).
 *   - `CandidateStatus` widened from literal 'inbox' to the 6-value terminal
 *     -marker enum (B1, jfv.2.1).
 *   - `ContentMetadata.proposedByRole` (R8, jfv.6.7).
 *   - OPTIONAL `origin` attestation ({ tokenHmac, channel, mintedAt }, H1).
 *     ICO's emitter does NOT mint origins — spool lines stay origin-less and
 *     govern as `unattested` by design (the accept-with-flag backward-compat
 *     policy; registrar 000-docs/046-AT-DECR). `origin` is deliberately
 *     OUTSIDE the UUID-v5 id derivation, so the content-stable spool id
 *     contract is unchanged.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// From bobs-big-brain-registrar/packages/schema/src/common.ts
// ---------------------------------------------------------------------------

const Uuid = z.string().uuid();
const IsoDatetime = z.string().datetime();
const NonEmptyString = z.string().trim().min(1);

const Tag = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

// ---------------------------------------------------------------------------
// From bobs-big-brain-registrar/packages/schema/src/enums.ts
// ---------------------------------------------------------------------------

const MemorySource = z.enum(['claude_session', 'manual', 'import', 'mcp', 'bulk_import']);
const TrustLevel = z.enum(['high', 'medium', 'low', 'untrusted']);
const MemoryCategory = z.enum([
  'decision',
  'pattern',
  'convention',
  'architecture',
  'troubleshooting',
  'onboarding',
  'reference',
]);
// B1 (jfv.2.1): widened from z.literal('inbox') — the sweep stamps terminal
// outcomes in place; every capture still writes as 'inbox'.
const CandidateStatus = z.enum([
  'inbox',
  'promoted',
  'rejected',
  'flagged',
  'duplicate',
  'quarantined',
]);
const AuthorType = z.enum(['human', 'ai', 'system']);
const Confidence = z.enum(['high', 'medium', 'low']);
const Sensitivity = z.enum(['public', 'internal', 'confidential', 'restricted']);
const ProposerRole = z.enum(['admin', 'member']);

const Author = z.object({
  type: AuthorType,
  id: NonEmptyString,
  name: NonEmptyString.optional(),
});

const TenantId = NonEmptyString;

const ContentMetadata = z.object({
  filePaths: z.array(z.string()).default([]),
  language: z.string().optional(),
  projectContext: z.string().optional(),
  sessionId: z.string().optional(),
  repoUrl: z.string().optional(),
  branch: z.string().optional(),
  confidence: Confidence.optional(),
  sensitivity: Sensitivity.optional(),
  tags: z.array(Tag).default([]),
  // R8 (jfv.6.7): stamped server-side at team intake; never on ICO emissions.
  proposedByRole: ProposerRole.optional(),
});

// ---------------------------------------------------------------------------
// From bobs-big-brain-registrar/packages/schema/src/memory-candidate.ts
// ---------------------------------------------------------------------------

const PrePolicyFlags = z.object({
  potentialSecret: z.boolean().default(false),
  lowConfidence: z.boolean().default(false),
  duplicateSuspect: z.boolean().default(false),
});

/**
 * The spool-candidate schema version INTKB accepts (5bm.6). ICO stamps
 * `schemaVersion: '1'`; a v2 line FAILS `safeParse` (literal mismatch) rather
 * than being silently stripped and ingested as v1. The `.default` keeps
 * legacy lines that omit the field valid at v1.
 */
const MEMORY_CANDIDATE_SCHEMA_VERSION = '1' as const;

/** H1 write-time provenance: tag-shaped, bounded capture-channel identifier.
 *  Reuses the Tag grammar deliberately — a future change to the tag grammar
 *  applies to both surfaces automatically (review finding on #179). */
const OriginChannel = Tag.max(64);

/**
 * H1 write-time provenance attestation — OPTIONAL on every candidate. HMAC
 * (hex) over (id, tenantId, capturedAt) under INTKB's per-installation
 * secret; verified govern-side before promotion. ICO never mints one.
 */
const CandidateOrigin = z.object({
  tokenHmac: z.string().regex(/^[0-9a-f]{64}$/),
  channel: OriginChannel,
  mintedAt: IsoDatetime,
});

/**
 * INTKB's canonical `MemoryCandidate` Zod schema, byte-equivalent vendored.
 */
export const IntkbMemoryCandidate = z.object({
  schemaVersion: z
    .literal(MEMORY_CANDIDATE_SCHEMA_VERSION)
    .default(MEMORY_CANDIDATE_SCHEMA_VERSION),
  id: Uuid,
  status: CandidateStatus,
  source: MemorySource,
  content: NonEmptyString,
  title: NonEmptyString,
  category: MemoryCategory,
  trustLevel: TrustLevel.default('medium'),
  author: Author,
  tenantId: TenantId,
  metadata: ContentMetadata.default({ filePaths: [], tags: [] }),
  prePolicyFlags: PrePolicyFlags.default({
    potentialSecret: false,
    lowConfidence: false,
    duplicateSuspect: false,
  }),
  capturedAt: IsoDatetime,
  origin: CandidateOrigin.optional(),
});
