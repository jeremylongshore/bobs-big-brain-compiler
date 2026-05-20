/**
 * Artifact listing and discovery for the ICO kernel (E8-B08).
 *
 * Lists all artifacts in `workspace/outputs/` with their frontmatter metadata
 * and promotion status from the database. Artifacts are sorted newest-first
 * by `generated_at`.
 *
 * Never throws — all error paths return err(Error).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Database } from 'better-sqlite3';
import matter from 'gray-matter';

import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Metadata for a single artifact file in `workspace/outputs/`.
 */
export interface ArtifactInfo {
  /** Workspace-relative path to the artifact (e.g. `outputs/reports/foo.md`). */
  path: string;
  /** Document title from YAML frontmatter. */
  title: string;
  /** Artifact type: `'report'` or `'slides'`. */
  type: string;
  /** ISO 8601 generation timestamp from frontmatter. */
  generatedAt: string;
  /** Model identifier used for generation. */
  model: string;
  /** Total tokens consumed (input + output). */
  tokensUsed: number;
  /** File size in bytes. */
  sizeBytes: number;
  /** Whether a matching row exists in the `promotions` table. */
  promoted: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Subdirectories under `workspace/outputs/` that contain artifacts. */
const ARTIFACT_SUBDIRS = ['reports', 'slides'] as const;

/**
 * Recursively collect absolute paths of all `.md` files under `dir`.
 * Returns an empty array when `dir` does not exist or cannot be read.
 */
function collectMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const results: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir) as unknown as string[];
  } catch {
    return [];
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      if (statSync(fullPath).isDirectory()) {
        results.push(...collectMarkdownFiles(fullPath));
      } else if (entry.endsWith('.md')) {
        results.push(fullPath);
      }
    } catch {
      // Skip unreadable entries.
    }
  }

  return results;
}

/**
 * Look up whether an artifact has been promoted.
 *
 * The promotions table stores workspace-relative paths in `source_path`.
 * We check for any row whose `source_path` matches the relative path of this
 * artifact.
 */
function isPromoted(db: Database, relativePath: string): boolean {
  try {
    const row = db
      .prepare<[string], { id: string }>('SELECT id FROM promotions WHERE source_path = ? LIMIT 1')
      .get(relativePath);
    return row !== undefined;
  } catch {
    // If the promotions table doesn't exist or the query fails, treat as
    // not promoted rather than propagating an error for the whole listing.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all artifacts in `workspace/outputs/` with metadata and promotion status.
 *
 * Scans `workspace/outputs/reports/` and `workspace/outputs/slides/` for `.md`
 * files, parses each file's YAML frontmatter, retrieves file stats, and queries
 * the `promotions` table to determine promotion status.
 *
 * Files with unparseable or incomplete frontmatter are skipped with a warning
 * logged to stderr (not returned as errors).
 *
 * The returned array is sorted by `generatedAt` descending (newest first). When
 * `generated_at` is absent or unparseable the file is sorted to the end.
 *
 * @param db            - Open better-sqlite3 database with migrations applied.
 * @param workspacePath - Absolute path to the workspace root directory.
 * @returns `ok(ArtifactInfo[])` on success, or `err(Error)` if the workspace
 *          path cannot be accessed.
 */
export function listArtifacts(db: Database, workspacePath: string): Result<ArtifactInfo[], Error> {
  const outputsRoot = join(workspacePath, 'outputs');

  // Collect all .md files across both subdirectories.
  let allFiles: string[];
  try {
    allFiles = ARTIFACT_SUBDIRS.flatMap((subDir) =>
      collectMarkdownFiles(join(outputsRoot, subDir)),
    );
  } catch (e) {
    return err(
      new Error(
        `Failed to scan artifact directories: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  const artifacts: ArtifactInfo[] = [];

  for (const absolutePath of allFiles) {
    // Build workspace-relative path (e.g. `outputs/reports/foo.md`).
    const relativePath = absolutePath.startsWith(workspacePath + '/')
      ? absolutePath.slice(workspacePath.length + 1)
      : absolutePath;

    // Read file contents.
    let raw: string;
    try {
      raw = readFileSync(absolutePath, 'utf-8');
    } catch {
      // Unreadable file — skip with a warning.
      process.stderr.write(`[artifacts] Cannot read "${relativePath}", skipping.\n`);
      continue;
    }

    // Parse frontmatter.
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch {
      process.stderr.write(
        `[artifacts] Cannot parse frontmatter in "${relativePath}", skipping.\n`,
      );
      continue;
    }

    const data = parsed.data as Record<string, unknown>;

    // Extract required fields — skip the file if any are missing.
    const title = typeof data['title'] === 'string' ? data['title'] : undefined;
    const type = typeof data['type'] === 'string' ? data['type'] : undefined;
    const generatedAt = typeof data['generated_at'] === 'string' ? data['generated_at'] : undefined;
    const model = typeof data['model'] === 'string' ? data['model'] : undefined;
    const tokensUsed = typeof data['tokens_used'] === 'number' ? data['tokens_used'] : undefined;

    if (
      title === undefined ||
      type === undefined ||
      generatedAt === undefined ||
      model === undefined ||
      tokensUsed === undefined
    ) {
      process.stderr.write(`[artifacts] Incomplete frontmatter in "${relativePath}", skipping.\n`);
      continue;
    }

    // Get file size.
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(absolutePath).size;
    } catch {
      // Non-fatal — leave at 0.
    }

    // Check promotion status.
    const promoted = isPromoted(db, relativePath);

    artifacts.push({
      path: relativePath,
      title,
      type,
      generatedAt,
      model,
      tokensUsed,
      sizeBytes,
      promoted,
    });
  }

  // Sort newest first. Files without a parseable timestamp sort to the end.
  artifacts.sort((a, b) => {
    const ta = Date.parse(a.generatedAt);
    const tb = Date.parse(b.generatedAt);
    const validA = !Number.isNaN(ta);
    const validB = !Number.isNaN(tb);

    if (validA && validB) return tb - ta;
    if (validA) return -1;
    if (validB) return 1;
    return 0;
  });

  return ok(artifacts);
}
