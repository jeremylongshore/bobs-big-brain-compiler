/**
 * VENDORED SNAPSHOT — do NOT edit by hand.
 *
 * Byte-equivalent copy of qmd-team-intent-kb/packages/schema/src/memory-
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
 *   1. Copy the relevant Zod schemas from qmd-team-intent-kb/packages/
 *      schema/src/ into this file (preserving structure).
 *   2. Run `pnpm test` in @ico/types — the contract test will report any
 *      shape mismatches between ICO's `SpoolMemoryCandidateSchema` and
 *      INTKB's `MemoryCandidate` shape.
 *   3. Update `packages/types/src/spool.ts` to match if mismatch found.
 *   4. Record the resync in IDEA-CHANGELOG.md.
 *
 * Source-of-truth path:
 *   qmd-team-intent-kb/packages/schema/src/memory-candidate.ts
 *   qmd-team-intent-kb/packages/schema/src/enums.ts
 *   qmd-team-intent-kb/packages/schema/src/common.ts
 *
 * Snapshot taken: 2026-05-24 (INTKB v0.6.0).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// From qmd-team-intent-kb/packages/schema/src/common.ts
// ---------------------------------------------------------------------------

const Uuid = z.string().uuid();
const IsoDatetime = z.string().datetime();
const NonEmptyString = z.string().trim().min(1);

const Tag = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

// ---------------------------------------------------------------------------
// From qmd-team-intent-kb/packages/schema/src/enums.ts
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
const CandidateStatus = z.literal('inbox');
const AuthorType = z.enum(['human', 'ai', 'system']);
const Confidence = z.enum(['high', 'medium', 'low']);
const Sensitivity = z.enum(['public', 'internal', 'confidential', 'restricted']);

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
});

// ---------------------------------------------------------------------------
// From qmd-team-intent-kb/packages/schema/src/memory-candidate.ts
// ---------------------------------------------------------------------------

const PrePolicyFlags = z.object({
  potentialSecret: z.boolean().default(false),
  lowConfidence: z.boolean().default(false),
  duplicateSuspect: z.boolean().default(false),
});

/**
 * INTKB's canonical `MemoryCandidate` Zod schema, byte-equivalent vendored.
 *
 * Note: INTKB's schema does NOT yet carry a `schemaVersion` field. ICO emits
 * one (defaulted to `'1'`); INTKB's parser silently strips it via the
 * default `z.object()` strip-unknown behaviour, which is verified working
 * in both Zod 3.x and 4.x.
 */
export const IntkbMemoryCandidate = z.object({
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
});
