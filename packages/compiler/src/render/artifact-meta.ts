/**
 * Artifact frontmatter validation for the ICO compiler (E8-B06).
 *
 * Validates that rendered artifacts have complete and well-typed YAML
 * frontmatter metadata. Scans `workspace/outputs/reports/` and
 * `workspace/outputs/slides/` recursively.
 *
 * Never throws — all error paths return err(Error).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import matter from 'gray-matter';

import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * YAML frontmatter fields expected on every compiled artifact.
 * Optional promotion fields are added after `ico promote`.
 */
export interface ArtifactFrontmatter {
  type: 'report' | 'slides';
  title: string;
  /** ISO 8601 generation timestamp. */
  generated_at: string;
  /** Absolute or workspace-relative paths of all sources used. */
  generated_from: string[];
  /** Basename of each source page included. */
  source_pages: string[];
  /** Model identifier used for generation. */
  model: string;
  /** Total tokens consumed (input + output). */
  tokens_used: number;
  // Optional promotion provenance — added by the promotion engine.
  promoted_from?: string;
  promoted_at?: string;
  promoted_by?: string;
}

/**
 * Result of validating a single artifact file's frontmatter.
 */
export interface ArtifactValidation {
  /** Whether all required fields are present and well-typed. */
  valid: boolean;
  /** Validation error messages (missing or wrongly-typed required fields). */
  errors: string[];
  /** Non-blocking warnings (e.g. missing optional fields). */
  warnings: string[];
  /** Parsed frontmatter data (may be partial if fields are missing). */
  frontmatter: Partial<ArtifactFrontmatter>;
}

// ---------------------------------------------------------------------------
// Required fields and validators
// ---------------------------------------------------------------------------

/**
 * Required fields for both report and slides types.
 */
const REQUIRED_FIELDS: Array<keyof ArtifactFrontmatter> = [
  'type',
  'title',
  'generated_at',
  'generated_from',
  'model',
  'tokens_used',
];

/**
 * Optional fields for which a warning is emitted when absent.
 */
const OPTIONAL_FIELDS: Array<keyof ArtifactFrontmatter> = ['source_pages'];

/**
 * Validate the shape of parsed frontmatter data and populate `errors` and
 * `warnings` arrays. Returns the typed partial frontmatter.
 */
function inspectFrontmatter(data: Record<string, unknown>): {
  errors: string[];
  warnings: string[];
  frontmatter: Partial<ArtifactFrontmatter>;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const frontmatter: Partial<ArtifactFrontmatter> = {};

  // --- type ---
  const typeValue = data['type'];
  if (typeValue === undefined) {
    errors.push('Missing required field: type');
  } else if (typeValue !== 'report' && typeValue !== 'slides') {
    const typeStr = typeof typeValue === 'string' ? typeValue : '[non-string]';
    errors.push(`Invalid value for "type": expected "report" or "slides", got "${typeStr}"`);
  } else {
    frontmatter.type = typeValue;
  }

  // --- title ---
  const titleValue = data['title'];
  if (titleValue === undefined || titleValue === null) {
    errors.push('Missing required field: title');
  } else if (typeof titleValue !== 'string' || titleValue.trim() === '') {
    errors.push('Field "title" must be a non-empty string');
  } else {
    frontmatter.title = titleValue;
  }

  // --- generated_at ---
  const generatedAtValue = data['generated_at'];
  if (generatedAtValue === undefined || generatedAtValue === null) {
    errors.push('Missing required field: generated_at');
  } else if (typeof generatedAtValue !== 'string' || generatedAtValue.trim() === '') {
    errors.push('Field "generated_at" must be a non-empty string (ISO 8601)');
  } else {
    frontmatter.generated_at = generatedAtValue;
  }

  // --- generated_from ---
  const generatedFromValue = data['generated_from'];
  if (generatedFromValue === undefined || generatedFromValue === null) {
    errors.push('Missing required field: generated_from');
  } else if (!Array.isArray(generatedFromValue)) {
    errors.push('Field "generated_from" must be an array of strings');
  } else {
    frontmatter.generated_from = generatedFromValue as string[];
  }

  // --- model ---
  const modelValue = data['model'];
  if (modelValue === undefined || modelValue === null) {
    errors.push('Missing required field: model');
  } else if (typeof modelValue !== 'string' || modelValue.trim() === '') {
    errors.push('Field "model" must be a non-empty string');
  } else {
    frontmatter.model = modelValue;
  }

  // --- tokens_used ---
  const tokensUsedValue = data['tokens_used'];
  if (tokensUsedValue === undefined || tokensUsedValue === null) {
    errors.push('Missing required field: tokens_used');
  } else if (typeof tokensUsedValue !== 'number' || !Number.isInteger(tokensUsedValue)) {
    errors.push('Field "tokens_used" must be an integer');
  } else {
    frontmatter.tokens_used = tokensUsedValue;
  }

  // --- slides-specific: marp must be true ---
  if (frontmatter.type === 'slides' && data['marp'] !== true) {
    errors.push('Slides artifact must have "marp: true" in frontmatter');
  }

  // --- optional: source_pages ---
  const sourcePagesValue = data['source_pages'];
  if (sourcePagesValue === undefined || sourcePagesValue === null) {
    warnings.push('Optional field "source_pages" is missing');
  } else if (!Array.isArray(sourcePagesValue)) {
    warnings.push('Optional field "source_pages" should be an array of strings');
  } else {
    frontmatter.source_pages = sourcePagesValue as string[];
  }

  // Suppress unused variable warning for REQUIRED_FIELDS / OPTIONAL_FIELDS
  // (they are the intended spec reference; we validate manually above for
  //  better per-field error messages).
  void REQUIRED_FIELDS;
  void OPTIONAL_FIELDS;

  // --- optional promotion fields (pass-through when present) ---
  if (typeof data['promoted_from'] === 'string') {
    frontmatter.promoted_from = data['promoted_from'];
  }
  if (typeof data['promoted_at'] === 'string') {
    frontmatter.promoted_at = data['promoted_at'];
  }
  if (typeof data['promoted_by'] === 'string') {
    frontmatter.promoted_by = data['promoted_by'];
  }

  return { errors, warnings, frontmatter };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate the YAML frontmatter of a single artifact file.
 *
 * Reads the file at `filePath`, parses its YAML frontmatter with gray-matter,
 * and checks that all required fields are present and well-typed.
 *
 * @param filePath - Absolute path to the artifact markdown file.
 * @returns `ok(ArtifactValidation)` with validation details, or
 *          `err(Error)` if the file cannot be read or parsed.
 */
export function validateArtifact(filePath: string): Result<ArtifactValidation, Error> {
  if (!existsSync(filePath)) {
    return err(new Error(`Artifact file not found: ${filePath}`));
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return err(
      new Error(
        `Failed to read artifact file "${filePath}": ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (e) {
    return err(
      new Error(
        `Failed to parse frontmatter in "${filePath}": ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  const { errors, warnings, frontmatter } = inspectFrontmatter(
    parsed.data as Record<string, unknown>,
  );

  return ok({
    valid: errors.length === 0,
    errors,
    warnings,
    frontmatter,
  });
}

/**
 * Validate all artifact files in `workspace/outputs/reports/` and
 * `workspace/outputs/slides/`.
 *
 * Scans both directories recursively and runs `validateArtifact` on each
 * `.md` file found. Non-markdown files are silently skipped.
 *
 * @param workspacePath - Absolute path to the workspace root directory.
 * @returns `ok(ArtifactValidation[])` — one entry per `.md` file found — or
 *          `err(Error)` if the outputs directory cannot be read.
 */
export function validateAllArtifacts(workspacePath: string): Result<ArtifactValidation[], Error> {
  const scanDirs = [
    join(workspacePath, 'outputs', 'reports'),
    join(workspacePath, 'outputs', 'slides'),
  ];

  /**
   * Recursively collect all `.md` file paths under `dir`.
   * Returns an empty array if `dir` does not exist.
   */
  function collectMarkdownFiles(dir: string): string[] {
    if (!existsSync(dir)) {
      return [];
    }

    const results: string[] = [];

    let entries: string[];
    try {
      entries = readdirSync(dir) as unknown as string[];
    } catch (e) {
      throw new Error(
        `Cannot read directory "${dir}": ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
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

  let allFiles: string[];
  try {
    allFiles = scanDirs.flatMap(collectMarkdownFiles);
  } catch (e) {
    return err(
      new Error(
        `Failed to scan artifact directories: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  const validations: ArtifactValidation[] = [];

  for (const filePath of allFiles) {
    const result = validateArtifact(filePath);
    if (!result.ok) {
      // File-level failures (e.g. unreadable) become an invalid entry rather
      // than propagating an error for the entire batch.
      validations.push({
        valid: false,
        errors: [result.error.message],
        warnings: [],
        frontmatter: {},
      });
    } else {
      validations.push(result.value);
    }
  }

  return ok(validations);
}
