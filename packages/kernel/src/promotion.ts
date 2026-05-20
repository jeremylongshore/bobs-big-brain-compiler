/**
 * Promotion engine — moves artifacts from `workspace/outputs/` into
 * `workspace/wiki/` as compiled knowledge.
 *
 * Enforces all seven promotion rules and three anti-patterns defined in the
 * Phase 1 promotion spec (018-AT-PROM).
 *
 * All functions return `Result<T, Error>` — never throw.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type { Database } from 'better-sqlite3';
import matter from 'gray-matter';

import { err, ok, type Result } from '@ico/types';

import { appendAuditLog } from './audit-log.js';
import { writeTrace } from './traces.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated error codes for promotion failures.
 * Each code maps to a distinct rejection reason so callers can render
 * actionable messages to the user.
 */
export type PromotionErrorCode =
  | 'INELIGIBLE_PATH' // source is not under workspace/outputs/
  | 'FILE_NOT_FOUND' // source file does not exist on disk
  | 'EMPTY_FILE' // source file has zero bytes
  | 'MISSING_FRONTMATTER' // source file has no YAML frontmatter or no `title` field
  | 'INVALID_TYPE' // targetType is not a valid PromotionType
  | 'DRAFT_REJECTED' // anti-pattern: path is a task draft
  | 'EVIDENCE_REJECTED' // anti-pattern: path is task evidence
  | 'NOT_CONFIRMED' // confirm flag is false
  | 'TARGET_EXISTS' // a file already exists at the computed target path
  | 'COPY_FAILED' // copyFileSync or post-copy write failed
  | 'AUDIT_WRITE_FAILED'; // DB insert, trace write, or audit-log append failed

/**
 * Typed error raised by the promotion engine.
 * Extends `Error` so it is compatible with `Result<T, Error>`.
 */
export class PromotionError extends Error {
  constructor(
    public readonly code: PromotionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PromotionError';
  }
}

/** The four target knowledge types for promoted artifacts. */
export type PromotionType = 'topic' | 'concept' | 'entity' | 'reference';

/** Input parameters for a single promotion request. */
export interface PromotionInput {
  /** Workspace-relative or absolute path to the artifact in `outputs/`. */
  sourcePath: string;
  /** Knowledge-layer type that determines the target wiki subdirectory. */
  targetType: PromotionType;
  /** Must be `true` — explicit confirmation gates every promotion. */
  confirm: boolean;
}

/** Successful promotion result. */
export interface PromotionResult {
  /** UUID v4 identifying this promotion record. */
  promotionId: string;
  /** Workspace-relative path to the source artifact. */
  sourcePath: string;
  /** Workspace-relative path to the promoted wiki page. */
  targetPath: string;
  /** Knowledge type of the promoted page. */
  targetType: PromotionType;
  /** SHA-256 digest of the source file at promotion time: `sha256:<hex>`. */
  sourceHash: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All valid promotion target types. */
export const VALID_PROMOTION_TYPES = ['topic', 'concept', 'entity', 'reference'] as const;

/** Maps each PromotionType to its wiki subdirectory (workspace-relative). */
const TYPE_DIRECTORY_MAP: Record<PromotionType, string> = {
  topic: 'wiki/topics',
  concept: 'wiki/concepts',
  entity: 'wiki/entities',
  reference: 'wiki/sources',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Computes a SHA-256 hex digest of a file's raw bytes.
 * Returns the digest prefixed with `sha256:`.
 */
function hashFile(absolutePath: string): string {
  const contents = readFileSync(absolutePath);
  return 'sha256:' + createHash('sha256').update(contents).digest('hex');
}

/**
 * Converts a page title into a URL-safe slug.
 *
 * Rules:
 * - Lowercase only
 * - Characters outside `[a-z0-9-]` are replaced with hyphens
 * - Spaces and underscores become hyphens
 * - Consecutive hyphens are collapsed to one
 * - Leading and trailing hyphens are stripped
 * - Maximum 80 characters
 */
function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s_]+/g, '-') // spaces and underscores → hyphens
    .replace(/[^a-z0-9-]/g, '-') // everything else → hyphens
    .replace(/-{2,}/g, '-') // collapse consecutive hyphens
    .replace(/^-+|-+$/g, '') // strip leading/trailing hyphens
    .slice(0, 80);
}

/**
 * Rewrites the YAML frontmatter of a markdown file to inject promotion
 * provenance fields.
 *
 * Adds three fields to the frontmatter:
 * - `promoted_from`: workspace-relative source path
 * - `promoted_at`: ISO 8601 UTC timestamp
 * - `promoted_by`: always `'user'`
 *
 * The file at `absolutePath` is read, mutated, and written back in-place.
 * Throws on any I/O error — callers must catch and handle rollback.
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Promote an artifact from `workspace/outputs/` into `workspace/wiki/`.
 *
 * Enforces the seven promotion rules:
 *  1. Source must be under `workspace/outputs/`
 *  2. Promotion requires explicit user command (`confirm === true`)
 *  3. `targetType` must be a valid `PromotionType`
 *  4. Content is COPIED (not moved) — source is preserved
 *  5. Promotion event is fully audited (DB + trace + audit file + log.md)
 *  6. Promoted pages enter the normal compilation lifecycle
 *  7. Automatic promotion is never allowed (actor is always 'user')
 *
 * Detects three anti-patterns and rejects them:
 *  1. Task drafts  — path contains `tasks/` and `drafts/`
 *  2. Unconfirmed  — `confirm` flag is false
 *  3. Task evidence — path contains `tasks/` and `evidence/`
 *
 * @param db            - Open better-sqlite3 database with migrations applied.
 * @param workspacePath - Absolute path to the workspace root directory.
 * @param input         - Promotion request parameters.
 * @returns `ok(PromotionResult)` on success, or `err(PromotionError)` on any
 *          eligibility failure or I/O error.
 */
export function promoteArtifact(
  db: Database,
  workspacePath: string,
  input: PromotionInput,
): Result<PromotionResult, PromotionError> {
  // -------------------------------------------------------------------------
  // Step 1: Resolve source path and verify it is under workspace/outputs/
  // -------------------------------------------------------------------------

  const outputsRoot = resolve(workspacePath, 'outputs');

  // Resolve the incoming path: treat as absolute if it already is, otherwise
  // resolve relative to the workspace root.
  const absoluteSource = resolve(workspacePath, input.sourcePath);

  // Normalise to a workspace-relative string for storage and display.
  const relativeSource = relative(workspacePath, absoluteSource);

  // The resolved path must begin with the outputs root (with a separator to
  // prevent prefix attacks like "outputs-other/file.md").
  if (!absoluteSource.startsWith(outputsRoot + '/') && absoluteSource !== outputsRoot) {
    return err(
      new PromotionError(
        'INELIGIBLE_PATH',
        `Source path is not under workspace/outputs/: ${relativeSource}`,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Anti-pattern A: task draft  (path contains tasks/ AND drafts/)
  // Anti-pattern C: task evidence (path contains tasks/ AND evidence/)
  // -------------------------------------------------------------------------

  const normalised = absoluteSource.replace(/\\/g, '/');

  if (normalised.includes('/tasks/') && normalised.includes('/drafts/')) {
    return err(
      new PromotionError('DRAFT_REJECTED', `Refusing to promote a task draft: ${relativeSource}`),
    );
  }

  if (normalised.includes('/tasks/') && normalised.includes('/evidence/')) {
    return err(
      new PromotionError(
        'EVIDENCE_REJECTED',
        `Refusing to promote task evidence: ${relativeSource}`,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Step 2: File must exist
  // -------------------------------------------------------------------------

  if (!existsSync(absoluteSource)) {
    return err(new PromotionError('FILE_NOT_FOUND', `Source file not found: ${relativeSource}`));
  }

  // -------------------------------------------------------------------------
  // Step 3: File must be non-empty
  // -------------------------------------------------------------------------

  let fileSize: number;
  try {
    fileSize = statSync(absoluteSource).size;
  } catch {
    return err(new PromotionError('FILE_NOT_FOUND', `Cannot stat source file: ${relativeSource}`));
  }

  if (fileSize === 0) {
    return err(new PromotionError('EMPTY_FILE', `Source file is empty: ${relativeSource}`));
  }

  // -------------------------------------------------------------------------
  // Step 4: Parse frontmatter — must have a `title` field
  // -------------------------------------------------------------------------

  let fileContent: string;
  try {
    fileContent = readFileSync(absoluteSource, 'utf-8');
  } catch {
    return err(new PromotionError('FILE_NOT_FOUND', `Cannot read source file: ${relativeSource}`));
  }

  let parsedFrontmatter: matter.GrayMatterFile<string>;
  try {
    parsedFrontmatter = matter(fileContent);
  } catch {
    return err(
      new PromotionError('MISSING_FRONTMATTER', `Cannot parse frontmatter in: ${relativeSource}`),
    );
  }

  const title = parsedFrontmatter.data['title'] as string | undefined;
  if (typeof title !== 'string' || title.trim() === '') {
    return err(
      new PromotionError(
        'MISSING_FRONTMATTER',
        `Source file has no valid "title" in frontmatter: ${relativeSource}`,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Step 5: Validate targetType
  // -------------------------------------------------------------------------

  if (!(VALID_PROMOTION_TYPES as readonly string[]).includes(input.targetType)) {
    return err(
      new PromotionError(
        'INVALID_TYPE',
        `Invalid targetType "${String(input.targetType)}". Must be one of: ${VALID_PROMOTION_TYPES.join(', ')}`,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Anti-pattern B: Promotion without review (confirm flag required)
  // Step 7: Automatic promotion never allowed
  // -------------------------------------------------------------------------

  if (!input.confirm) {
    return err(
      new PromotionError(
        'NOT_CONFIRMED',
        'Promotion requires explicit confirmation (confirm: true)',
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Step 8: Compute target path — check for collision
  // -------------------------------------------------------------------------

  const slug = slugifyTitle(title);
  const targetDir = TYPE_DIRECTORY_MAP[input.targetType];
  const targetRelative = join(targetDir, `${slug}.md`);
  const absoluteTarget = resolve(workspacePath, targetRelative);

  if (existsSync(absoluteTarget)) {
    return err(
      new PromotionError('TARGET_EXISTS', `Target path already exists: ${targetRelative}`),
    );
  }

  // -------------------------------------------------------------------------
  // Copy + Audit Phase
  // -------------------------------------------------------------------------

  const promotionId = randomUUID();
  const promotedAt = new Date().toISOString();

  // Compute SHA-256 of source before copy.
  let sourceHash: string;
  try {
    sourceHash = hashFile(absoluteSource);
  } catch {
    return err(
      new PromotionError('COPY_FAILED', `Cannot compute hash for source: ${relativeSource}`),
    );
  }

  // Ensure the target directory exists.
  try {
    mkdirSync(resolve(workspacePath, targetDir), { recursive: true });
  } catch {
    return err(new PromotionError('COPY_FAILED', `Cannot create target directory: ${targetDir}`));
  }

  // Build promoted content in memory (single write — no copy + re-read cycle).
  // The source file was already parsed into `parsedFrontmatter` during the
  // eligibility check, so we inject the promotion fields and write once.
  try {
    parsedFrontmatter.data['promoted_from'] = relativeSource;
    parsedFrontmatter.data['promoted_at'] = promotedAt;
    parsedFrontmatter.data['promoted_by'] = 'user';

    const updatedContent = matter.stringify(parsedFrontmatter.content, parsedFrontmatter.data);
    writeFileSync(absoluteTarget, updatedContent, 'utf-8');
  } catch {
    return err(
      new PromotionError('COPY_FAILED', `Failed to write promoted file to ${targetRelative}`),
    );
  }

  // Also preserve the original (copy-not-move invariant). The source was
  // already read but never modified — it stays on disk untouched.

  // Write the DB record, trace, audit file, and log.md. Any failure after
  // the file write triggers rollback (delete the target AND the DB row).
  try {
    // 4b. Insert into the promotions table.
    db.prepare<[string, string, string, string, string, string, string | null], void>(
      `INSERT INTO promotions (id, source_path, target_path, target_type, promoted_at, promoted_by, source_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      promotionId,
      relativeSource,
      targetRelative,
      input.targetType,
      promotedAt,
      'user',
      sourceHash,
    );

    // 4c. Write a trace event.
    const traceResult = writeTrace(
      db,
      workspacePath,
      'promotion',
      {
        promotionId,
        sourcePath: relativeSource,
        targetPath: targetRelative,
        targetType: input.targetType,
        sourceHash,
        promotedBy: 'user',
      },
      { summary: `Promoted ${relativeSource} → ${targetRelative}` },
    );

    if (!traceResult.ok) {
      throw traceResult.error;
    }

    // 4d. Write the audit JSONL file for this promotion.
    const auditDir = resolve(workspacePath, 'audit', 'promotions');
    mkdirSync(auditDir, { recursive: true });
    const auditFilePath = join(auditDir, `${promotionId}.jsonl`);
    const auditRecord = JSON.stringify({
      promotionId,
      sourcePath: relativeSource,
      targetPath: targetRelative,
      targetType: input.targetType,
      sourceHash,
      promotedAt,
      promotedBy: 'user',
    });
    writeFileSync(auditFilePath, auditRecord + '\n', 'utf-8');

    // 4e. Append to audit/log.md.
    const logResult = appendAuditLog(
      workspacePath,
      'promotion',
      `Promoted ${relativeSource} → ${targetRelative} (${input.targetType})`,
    );

    if (!logResult.ok) {
      throw logResult.error;
    }
  } catch (e) {
    // Rollback: delete the copied file AND the DB row so the wiki remains
    // consistent. The DB row may or may not exist depending on which step
    // failed, so both cleanup operations are best-effort.
    try {
      if (existsSync(absoluteTarget)) {
        unlinkSync(absoluteTarget);
      }
    } catch {
      // Best-effort rollback — swallow secondary errors.
    }
    try {
      db.prepare<[string], void>('DELETE FROM promotions WHERE id = ?').run(promotionId);
    } catch {
      // Best-effort rollback — swallow secondary errors.
    }

    const underlying = e instanceof Error ? e : new Error(String(e));
    return err(
      new PromotionError(
        'AUDIT_WRITE_FAILED',
        `Promotion audit phase failed (rolled back): ${underlying.message}`,
      ),
    );
  }

  return ok({
    promotionId,
    sourcePath: relativeSource,
    targetPath: targetRelative,
    targetType: input.targetType,
    sourceHash,
  });
}
