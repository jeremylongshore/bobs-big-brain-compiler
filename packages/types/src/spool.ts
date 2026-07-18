/**
 * Spool boundary schema — mirrors qmd-team-intent-kb's `MemoryCandidate` Zod
 * shape from `packages/schema/src/memory-candidate.ts`.
 *
 * This file is the load-bearing contract between ICO (writer) and INTKB
 * (reader). Per ADR (035-AT-DECR §4.1, CTO call), ICO does NOT depend on
 * `@qmd-team-intent-kb/schema` — that would invert the upstream→downstream
 * direction the thesis (034-AT-NTRP) argues for. Instead, ICO mirrors the
 * schema here and a CI contract test (see `spool-contract.test.ts`) imports
 * INTKB's schema as a dev-dep ONLY and round-trips a sample emission through
 * `MemoryCandidate.safeParse` to catch drift.
 *
 * Tripwire: if INTKB's schema changes more than once after v1 ships, extract
 * to a shared `@intent/memory-candidate-contract` package — bead
 * `intentional-cognition-os-ziz.6` tracks this conditional.
 *
 * @module @ico/types/spool
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enum mirrors (must match qmd-team-intent-kb/packages/schema/src/enums.ts)
// ---------------------------------------------------------------------------

// `bulk_import` (5bm.8) marks a whole-machine / large digestion — stamped by a
// `--bulk` emit (with low trust) so a whole-machine mount is distinguishable from
// a deliberate `import` and INTKB's source-trust policy can gate it. Kept in
// lock-step with INTKB's MemorySource (see the contract snapshot).
export const SpoolMemorySourceSchema = z.enum([
  'claude_session',
  'manual',
  'import',
  'mcp',
  'bulk_import',
]);
export type SpoolMemorySource = z.infer<typeof SpoolMemorySourceSchema>;

export const SpoolTrustLevelSchema = z.enum(['high', 'medium', 'low', 'untrusted']);
export type SpoolTrustLevel = z.infer<typeof SpoolTrustLevelSchema>;

export const SpoolMemoryCategorySchema = z.enum([
  'decision',
  'pattern',
  'convention',
  'architecture',
  'troubleshooting',
  'onboarding',
  'reference',
]);
export type SpoolMemoryCategory = z.infer<typeof SpoolMemoryCategorySchema>;

export const SpoolCandidateStatusSchema = z.literal('inbox');
export type SpoolCandidateStatus = z.infer<typeof SpoolCandidateStatusSchema>;

export const SpoolAuthorTypeSchema = z.enum(['human', 'ai', 'system']);
export type SpoolAuthorType = z.infer<typeof SpoolAuthorTypeSchema>;

export const SpoolConfidenceSchema = z.enum(['high', 'medium', 'low']);
export const SpoolSensitivitySchema = z.enum(['public', 'internal', 'confidential', 'restricted']);

// ---------------------------------------------------------------------------
// Common-shape mirrors
// ---------------------------------------------------------------------------

export const SpoolAuthorSchema = z.object({
  type: SpoolAuthorTypeSchema,
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
});
export type SpoolAuthor = z.infer<typeof SpoolAuthorSchema>;

export const SpoolContentMetadataSchema = z.object({
  filePaths: z.array(z.string()).default([]),
  language: z.string().optional(),
  projectContext: z.string().optional(),
  sessionId: z.string().optional(),
  repoUrl: z.string().optional(),
  branch: z.string().optional(),
  confidence: SpoolConfidenceSchema.optional(),
  sensitivity: SpoolSensitivitySchema.optional(),
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).default([]),
});
export type SpoolContentMetadata = z.infer<typeof SpoolContentMetadataSchema>;

export const SpoolPrePolicyFlagsSchema = z.object({
  potentialSecret: z.boolean().default(false),
  lowConfidence: z.boolean().default(false),
  duplicateSuspect: z.boolean().default(false),
});
export type SpoolPrePolicyFlags = z.infer<typeof SpoolPrePolicyFlagsSchema>;

// ---------------------------------------------------------------------------
// MemoryCandidate mirror (the wire schema)
// ---------------------------------------------------------------------------

/**
 * Schema version field — ICO emits `'1'`. INTKB's reader silently fills the
 * default when absent, so v1 readers parse v0 files. When ICO v2 emits
 * `schemaVersion: '2'`, a v1 INTKB will reject those lines via `safeParse`
 * (literal mismatch) rather than silently dropping fields — giving a clean
 * upgrade signal. See agent review consolidated notes, REQUIRED fix #2.
 */
export const SpoolSchemaVersionSchema = z.literal('1').default('1');
export type SpoolSchemaVersion = z.infer<typeof SpoolSchemaVersionSchema>;

/**
 * The wire-shape ICO emits per spool JSONL line. Mirrors INTKB's
 * `MemoryCandidate` byte-equivalent with the added `schemaVersion` field.
 */
export const SpoolMemoryCandidateSchema = z.object({
  schemaVersion: SpoolSchemaVersionSchema,
  id: z.string().uuid(),
  status: SpoolCandidateStatusSchema,
  source: SpoolMemorySourceSchema,
  content: z.string().trim().min(1),
  title: z.string().trim().min(1),
  category: SpoolMemoryCategorySchema,
  trustLevel: SpoolTrustLevelSchema.default('medium'),
  author: SpoolAuthorSchema,
  tenantId: z.string().trim().min(1),
  metadata: SpoolContentMetadataSchema.default({ filePaths: [], tags: [] }),
  prePolicyFlags: SpoolPrePolicyFlagsSchema.default({
    potentialSecret: false,
    lowConfidence: false,
    duplicateSuspect: false,
  }),
  capturedAt: z.string().datetime(),
});
export type SpoolMemoryCandidate = z.infer<typeof SpoolMemoryCandidateSchema>;

// ---------------------------------------------------------------------------
// ICO-side constants
// ---------------------------------------------------------------------------

/**
 * Singleton author identity for every ICO-emitted spool candidate.
 * Imported by both the kernel emitter and the tests so a future identity
 * change propagates from one place. Uses `satisfies` to preserve the
 * narrow `type: 'ai'` literal instead of widening to `string`.
 */
export const ICO_AUTHOR = {
  type: 'ai',
  id: 'ico',
  name: 'Intentional Cognition OS',
} as const satisfies SpoolAuthor;

/**
 * Maximum byte length of the `content` field accepted by the spool emitter.
 * Per agent review consolidated notes BLOCK fix #2: reject (do NOT truncate)
 * candidates over this size. Anything larger is almost certainly an ingestion
 * bug rather than legitimate compiled content.
 */
export const SPOOL_CONTENT_MAX_BYTES = 65_536;

/**
 * Deterministic UUID v5 namespace for spool-emitted candidate IDs. Per
 * agent review consolidated notes REQUIRED fix #1, ICO uses UUID v5
 * derived from `(workspaceId, sourceWikiPath, contentSha256)` so
 * re-emitting an unchanged compiled page produces the same candidate ID
 * and INTKB's id-dedupe silently skips it. This namespace MUST NOT change
 * without a coordinated INTKB-side migration — if it changes, INTKB
 * starts seeing "new" candidates for content it has already curated.
 *
 * Generated 2026-05-24 via `randomUUID()`; locked from then on.
 */
export const SPOOL_UUID_NAMESPACE = '6c6f6e67-7368-6f72-6500-69636f73706c';
