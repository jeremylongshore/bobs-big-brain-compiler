/**
 * Frontmatter validation and schema enforcement for compiled wiki pages.
 *
 * Validates compiled page files (or raw frontmatter objects) against the
 * Zod schemas exported from @ico/types. Each page type has its own schema;
 * the `type` field in frontmatter is the discriminator that drives routing.
 *
 * Never throws — all failures are returned as `err(Error)` or as a
 * `ValidationResult` with `valid: false`.
 */

import { readFileSync } from 'node:fs';

import {
  CompiledPageTypeSchema,
  ConceptFrontmatterSchema,
  ContradictionFrontmatterSchema,
  EntityFrontmatterSchema,
  err,
  ok,
  OpenQuestionFrontmatterSchema,
  type Result,
  SourceSummaryFrontmatterSchema,
  TopicFrontmatterSchema,
} from '@ico/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The result of validating a compiled page's frontmatter. */
export interface ValidationResult {
  /** Whether the frontmatter satisfied its schema. */
  valid: boolean;
  /** The page type extracted from the `type` field (or the supplied pageType). */
  pageType: string;
  /** Human-readable description of each validation failure. Empty when valid. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Schema routing
// ---------------------------------------------------------------------------

/**
 * Return the Zod schema for a given page type, or `null` when unknown.
 *
 * @param pageType - Value of the `type` frontmatter field.
 */
function getSchemaForType(pageType: string) {
  switch (pageType) {
    case 'source-summary':
      return SourceSummaryFrontmatterSchema;
    case 'concept':
      return ConceptFrontmatterSchema;
    case 'topic':
      return TopicFrontmatterSchema;
    case 'entity':
      return EntityFrontmatterSchema;
    case 'contradiction':
      return ContradictionFrontmatterSchema;
    case 'open-question':
      return OpenQuestionFrontmatterSchema;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Parse a YAML-like frontmatter block into a `Record<string, unknown>`.
 *
 * Supports:
 * - Simple scalars: `key: value`
 * - Booleans: `true` / `false` (case-insensitive)
 * - Numbers: integers and floats
 * - Inline arrays: `key: [a, b, c]`
 * - Multi-line block arrays:
 *   ```
 *   key:
 *     - item1
 *     - item2
 *   ```
 *
 * @param block - Raw text between the `---` delimiters (not including them).
 */
function parseFrontmatterBlock(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = block.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    i++;

    // Skip blank lines and comment lines.
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const key = line.slice(0, colon).trim();
    if (key === '') continue;

    const rawValue = line.slice(colon + 1).trimEnd();
    const value = rawValue.trimStart();

    if (value === '') {
      // Possibly a block-sequence key: look ahead for `- item` lines.
      const items: string[] = [];
      while (i < lines.length) {
        const next = lines[i] ?? '';
        // A block-sequence item starts with optional indentation then `- `.
        const match = /^[ \t]*-[ \t]+(.*)$/.exec(next);
        if (match !== null && match[1] !== undefined) {
          items.push(match[1].trim());
          i++;
        } else if (next.trim() === '') {
          // Blank lines inside a block sequence are skipped.
          i++;
        } else {
          break;
        }
      }
      result[key] = items;
      continue;
    }

    // Inline array: `[a, b, c]`
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1);
      result[key] = inner
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      continue;
    }

    // Boolean
    if (value.toLowerCase() === 'true') {
      result[key] = true;
      continue;
    }
    if (value.toLowerCase() === 'false') {
      result[key] = false;
      continue;
    }

    // Number (integer or float)
    const asNumber = Number(value);
    if (value !== '' && !Number.isNaN(asNumber)) {
      result[key] = asNumber;
      continue;
    }

    // Plain string
    result[key] = value;
  }

  return result;
}

/**
 * Extract the frontmatter block from a raw file string.
 *
 * Returns `null` when no valid `---`-delimited block is present at the start.
 *
 * @param raw - Full file contents as a string.
 */
function extractFrontmatterBlock(raw: string): string | null {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return null;
  }

  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) {
    // Also check for Windows-style line endings at the closing delimiter.
    const endCR = raw.indexOf('\n---\r\n', 4);
    if (endCR === -1) return null;
    return raw.slice(4, endCR);
  }

  return raw.slice(4, end);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate frontmatter content directly, without reading a file.
 *
 * Routes the supplied `frontmatter` object to the Zod schema for `pageType`
 * and returns a {@link ValidationResult} describing whether it is valid.
 *
 * @param frontmatter - Raw frontmatter as a plain object.
 * @param pageType    - The page type string used to select the schema.
 */
export function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  pageType: string,
): ValidationResult {
  // Validate that pageType is a known enum value.
  const typeCheck = CompiledPageTypeSchema.safeParse(pageType);
  if (!typeCheck.success) {
    return {
      valid: false,
      pageType,
      errors: [`Unknown page type: "${pageType}"`],
    };
  }

  const schema = getSchemaForType(pageType);
  if (schema === null) {
    // Should not be reachable after the enum check above, but guard anyway.
    return {
      valid: false,
      pageType,
      errors: [`No schema registered for page type: "${pageType}"`],
    };
  }

  const parsed = schema.safeParse(frontmatter);
  if (parsed.success) {
    return { valid: true, pageType, errors: [] };
  }

  const errors = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') + ': ' : '';
    return `${path}${issue.message}`;
  });

  return { valid: false, pageType, errors };
}

/**
 * Validate raw compiled-page CONTENT (a string, not a file) against its
 * frontmatter schema. This is the inline variant the compiler passes call
 * after the model responds and BEFORE the atomic write — a page that fails
 * here is skipped-with-trace instead of becoming visible (bead
 * intentional-cognition-os-l13.1).
 *
 * Returns `err(Error)` when no `---`-delimited frontmatter block is present.
 * Returns `ok(ValidationResult)` for all schema-level results, including
 * failures — the caller inspects `result.value.valid` / `.errors`.
 *
 * @param raw - Full page content as a string.
 */
export function validateCompiledContent(raw: string): Result<ValidationResult, Error> {
  const block = extractFrontmatterBlock(raw);
  if (block === null) {
    return err(new Error('No frontmatter block found in content'));
  }

  const frontmatter = parseFrontmatterBlock(block);
  const rawType = frontmatter['type'];
  const pageType = typeof rawType === 'string' ? rawType : '';

  if (pageType === '') {
    return ok({
      valid: false,
      pageType: '',
      errors: ['Missing required field: type'],
    });
  }

  return ok(validateFrontmatter(frontmatter, pageType));
}

/**
 * Validate a compiled page file against its frontmatter schema.
 *
 * Steps:
 * 1. Read the file from disk.
 * 2. Extract the `---`-delimited frontmatter block.
 * 3. Parse the block into a plain object.
 * 4. Extract the `type` field to determine which Zod schema to apply.
 * 5. Validate and return a {@link ValidationResult}.
 *
 * Returns `err(Error)` on I/O failures or when no frontmatter block is found.
 * Returns `ok(ValidationResult)` for all schema-level results, including
 * failures — the caller inspects `result.value.valid` and `result.value.errors`.
 *
 * @param filePath - Absolute path to the compiled `.md` page file.
 */
export function validateCompiledPage(filePath: string): Result<ValidationResult, Error> {
  // 1. Read the file.
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }

  // 2. Extract the frontmatter block.
  const block = extractFrontmatterBlock(raw);
  if (block === null) {
    return err(new Error(`No frontmatter block found in file: ${filePath}`));
  }

  // 3. Parse the block.
  const frontmatter = parseFrontmatterBlock(block);

  // 4. Extract the type discriminator.
  const rawType = frontmatter['type'];
  const pageType = typeof rawType === 'string' ? rawType : '';

  if (pageType === '') {
    return ok({
      valid: false,
      pageType: '',
      errors: ['Missing required field: type'],
    });
  }

  // 5. Delegate to validateFrontmatter.
  return ok(validateFrontmatter(frontmatter, pageType));
}
