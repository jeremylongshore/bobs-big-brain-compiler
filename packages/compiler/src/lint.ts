/**
 * Lint logic for compiled wiki state.
 *
 * Audits the workspace for five categories of issue:
 *   1. Schema validation — every compiled page must satisfy its
 *      frontmatter schema.
 *   2. Staleness — compiled pages whose source has been re-ingested
 *      since they were compiled.
 *   3. Uncompiled sources — sources with no summary compilation record.
 *   4. Orphans — wiki pages with no resolved incoming wiki references.
 *   5. Duplicate output paths — conflicting identities or unresolved legacy owners.
 *
 * This module is pure logic — file walking, validation, DB queries.
 * The CLI's `ico lint` command imports `runLint` here and adds the
 * commander wiring + output formatting. Other callers (benchmarks,
 * integration tests, programmatic consumers) can also import directly.
 *
 * Moved out of `packages/cli/src/commands/lint.ts` in E10-B06 so the
 * lint benchmark can call it without a synthetic cross-package import.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  appendAuditLog,
  closeDatabase,
  type Database,
  initDatabase,
  writeTrace,
} from '@ico/kernel';

import { detectStalePages, getUncompiledSources, type StalePageInfo } from './staleness.js';
import { validateCompiledPage, type ValidationResult } from './validation.js';
import { wikiReferenceResolver, wikiReferences } from './wiki-references.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Wiki subdirectories scanned for compiled pages. */
const WIKI_SUBDIRS = [
  'sources',
  'concepts',
  'entities',
  'topics',
  'contradictions',
  'open-questions',
] as const;

/** Source summary pages are never orphans — they anchor the provenance chain. */
const SOURCE_SUMMARY_SUBDIR = 'sources';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-page schema validation failure. */
export interface SchemaError {
  /** Path to the page file, relative to the workspace root. */
  path: string;
  /** Human-readable validation errors reported by the schema. */
  errors: string[];
}

/** Duplicate-path groups are never silently repaired. Legacy rows lack proven identity. */
export interface OutputPathConflict {
  path: string;
  kind: 'conflicting-identities' | 'unverifiable-legacy';
  identities: string[];
  compilationIds: string[];
}

/** Full result of a lint run. */
export interface LintResult {
  schema: {
    valid: number;
    invalid: number;
    errors: SchemaError[];
  };
  staleness: {
    stale: number;
    pages: StalePageInfo[];
  };
  uncompiled: {
    count: number;
    sources: Array<{ id: string; path: string; type: string }>;
  };
  orphans: {
    count: number;
    pages: string[];
  };
  outputPaths: { count: number; conflicts: OutputPathConflict[] };
  issues: number;
}

// ---------------------------------------------------------------------------
// Wiki scanning
// ---------------------------------------------------------------------------

/**
 * Return the absolute paths of every `.md` file found in the scanned
 * wiki subdirectories. `.gitkeep` files are excluded.
 *
 * @param wikiPath - Absolute path to `wiki/`.
 */
export function scanWikiPages(wikiPath: string): string[] {
  const pages: string[] = [];

  for (const subdir of WIKI_SUBDIRS) {
    const dirPath = join(wikiPath, subdir);
    if (!existsSync(dirPath)) continue;

    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      if (!entry.endsWith('.md') || entry === '.gitkeep') continue;
      pages.push(join(dirPath, entry));
    }
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Orphan detection
// ---------------------------------------------------------------------------

/**
 * Extract all `[[slug]]`-style wikilink targets from a markdown string.
 *
 * @param content - Raw file content.
 * @returns Array of slug strings found in wikilinks.
 */
export function extractWikilinks(content: string): string[] {
  const slugs: string[] = [];
  // Fresh regex per call — see citation handler comment for the
  // module-level /g + lastIndex bleed hazard this avoids (PR #67).
  const RE = /\[\[([^\]|]+)(?:\|[^\]]+)?]]/g;
  let match: RegExpExecArray | null;
  while ((match = RE.exec(content)) !== null) {
    const slug = match[1];
    if (slug !== undefined && slug.trim() !== '') {
      slugs.push(slug.trim());
    }
  }
  return slugs;
}

/**
 * Detect wiki pages that have no incoming `[[slug]]` backlinks from
 * any other page in the wiki.
 *
 * Source-summary pages (`wiki/sources/`) are never considered orphans
 * — they are always the root of the provenance chain.
 *
 * @param wikiPath - Absolute path to `wiki/`.
 * @param allPages - Absolute paths of all scanned wiki pages.
 */
export function detectOrphans(wikiPath: string, allPages: string[]): string[] {
  const pages = allPages.flatMap((path) => {
    try {
      return [{ path, slug: basename(path, '.md'), content: readFileSync(path, 'utf8') }];
    } catch {
      return [];
    }
  });
  const resolveReference = wikiReferenceResolver(pages);
  const referencedPaths = new Set<string>();
  for (const page of pages) {
    for (const reference of wikiReferences(page.content)) {
      const target = resolveReference(reference);
      if (target) referencedPaths.add(target.path);
    }
  }

  const sourcesDirPath = join(wikiPath, SOURCE_SUMMARY_SUBDIR);
  const orphans: string[] = [];

  for (const pagePath of allPages) {
    if (basename(pagePath) === 'index.md') continue;
    if (pagePath.startsWith(sourcesDirPath + '/') || pagePath.startsWith(sourcesDirPath + '\\')) {
      continue;
    }
    if (!referencedPaths.has(pagePath)) {
      orphans.push(pagePath);
    }
  }

  return orphans;
}

/** Compare logical owners, rather than counting repeat compilation rows as collisions. */
export function detectOutputPathConflicts(db: Database): OutputPathConflict[] {
  const rows = db
    .prepare('SELECT id, source_id, type, output_path FROM compilations ORDER BY output_path, id')
    .all() as Array<{ id: string; source_id: string | null; type: string; output_path: string }>;
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = groups.get(row.output_path) ?? [];
    group.push(row);
    groups.set(row.output_path, group);
  }
  const conflicts: OutputPathConflict[] = [];
  for (const [path, group] of groups) {
    if (group.length < 2) continue;
    const identities = new Set<string>();
    let unknown = false;
    for (const row of group) {
      if (row.type === 'summary' && row.source_id && row.source_id !== 'batch') {
        identities.add(`summary:${row.source_id}`);
      } else if (
        row.type !== 'summary' &&
        row.source_id !== 'batch' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id)
      ) {
        identities.add(`${row.type}:${row.id}`);
      } else {
        // Historical batch/random-ID rows cannot prove whether two rows mean
        // different pages or repeated compilation of one page.
        unknown = true;
      }
    }
    if (identities.size > 1 || unknown) {
      conflicts.push({
        path,
        kind: identities.size > 1 ? 'conflicting-identities' : 'unverifiable-legacy',
        identities: [...identities].sort(),
        compilationIds: group.map((row) => row.id),
      });
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Core lint logic
// ---------------------------------------------------------------------------

/**
 * Run all lint checks against the workspace and return a `LintResult`.
 *
 * Emits `lint.run` + `lint.result` traces (011-AT-TRSC §6.19–6.20) and
 * appends a human-readable line to `audit/log.md`.
 *
 * @param workspaceRoot - Absolute path to the workspace root.
 * @param dbPath        - Absolute path to `.ico/state.db`.
 * @throws When the database cannot be opened.
 */
export function runLint(workspaceRoot: string, dbPath: string): LintResult {
  // Capture the wall-clock start BEFORE schema validation so the
  // duration_ms reported in lint.result reflects the full lint cost,
  // not just the DB-backed slice. Schema validation can dominate on
  // large wikis (PR #69 review).
  const lintRunStart = Date.now();
  const wikiPath = join(workspaceRoot, 'wiki');

  // --- 1. Schema validation -------------------------------------------------
  const allPages = scanWikiPages(wikiPath);
  const schemaErrors: SchemaError[] = [];
  let validCount = 0;

  for (const pagePath of allPages) {
    const result = validateCompiledPage(pagePath);
    if (!result.ok) {
      schemaErrors.push({
        path: pagePath,
        errors: [result.error.message],
      });
      continue;
    }
    const validation: ValidationResult = result.value;
    if (validation.valid) {
      validCount++;
    } else {
      schemaErrors.push({ path: pagePath, errors: validation.errors });
    }
  }

  // --- 2 & 3. DB-backed checks ----------------------------------------------
  const dbResult = initDatabase(dbPath);
  if (!dbResult.ok) {
    throw new Error(`Failed to open database: ${dbResult.error.message}`);
  }
  const db = dbResult.value;

  const lintCorrelationId = randomUUID();

  let stalePages: StalePageInfo[];
  let uncompiledSources: Array<{ id: string; path: string; type: string }>;
  let orphanPaths: string[];
  let result: LintResult;

  try {
    writeTrace(
      db,
      workspaceRoot,
      'lint.run',
      { lint_type: 'all', scope: 'all' },
      { correlationId: lintCorrelationId },
    );

    const staleResult = detectStalePages(db);
    if (!staleResult.ok) {
      throw new Error(`Staleness check failed: ${staleResult.error.message}`);
    }
    stalePages = staleResult.value;

    const uncompiledResult = getUncompiledSources(db);
    if (!uncompiledResult.ok) {
      throw new Error(`Uncompiled sources check failed: ${uncompiledResult.error.message}`);
    }
    uncompiledSources = uncompiledResult.value;

    // --- 4. Orphan detection ------------------------------------------------
    orphanPaths = detectOrphans(wikiPath, allPages);

    const outputPathConflicts = detectOutputPathConflicts(db);

    // --- 5. Aggregate -------------------------------------------------------
    const issues =
      schemaErrors.length +
      stalePages.length +
      uncompiledSources.length +
      orphanPaths.length +
      outputPathConflicts.length;

    result = {
      schema: {
        valid: validCount,
        invalid: schemaErrors.length,
        errors: schemaErrors,
      },
      staleness: {
        stale: stalePages.length,
        pages: stalePages,
      },
      uncompiled: {
        count: uncompiledSources.length,
        sources: uncompiledSources,
      },
      orphans: {
        count: orphanPaths.length,
        pages: orphanPaths,
      },
      outputPaths: { count: outputPathConflicts.length, conflicts: outputPathConflicts },
      issues,
    };

    // Per 011-AT-TRSC §6.20: lint.result payload includes `issues_found`
    // and an `issues` array of {path, severity, message}.
    const issuePayload = [
      ...outputPathConflicts.map((conflict) => ({
        path: conflict.path,
        severity: 'error',
        message: `duplicate output path: ${conflict.kind}`,
      })),
      ...schemaErrors.map((e) => ({
        path: e.path,
        severity: 'error',
        message: `schema invalid: ${e.errors.join('; ')}`,
      })),
      ...stalePages.map((p) => ({
        path: p.outputPath,
        severity: 'warning',
        message: 'compiled page is stale relative to its source',
      })),
      ...uncompiledSources.map((s) => ({
        path: s.path,
        severity: 'info',
        message: 'source has no compilation record',
      })),
      ...orphanPaths.map((p) => ({
        path: p,
        severity: 'warning',
        message: 'orphan wiki page — no incoming wikilinks',
      })),
    ];

    writeTrace(
      db,
      workspaceRoot,
      'lint.result',
      {
        lint_type: 'all',
        scope: 'all',
        issues_found: issues,
        issues: issuePayload,
        duration_ms: Date.now() - lintRunStart,
      },
      { correlationId: lintCorrelationId },
    );
    appendAuditLog(
      workspaceRoot,
      'lint.result',
      `Lint reported ${issues} issue(s) across schema/staleness/uncompiled/orphans/output-paths`,
    );
  } finally {
    closeDatabase(db);
  }

  return result;
}
