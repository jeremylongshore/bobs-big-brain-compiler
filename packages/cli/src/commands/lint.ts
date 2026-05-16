/**
 * `ico lint` — audit compiled knowledge for schema, staleness, and structural
 * issues.
 *
 * Checks performed:
 *   1. Schema validation — every compiled page in wiki/ validates against its
 *      frontmatter schema.
 *   2. Staleness — any compilation whose source has been re-ingested since the
 *      compilation ran.
 *   3. Uncompiled sources — sources with no summary compilation record.
 *   4. Orphan pages — wiki pages with no incoming [[slug]] backlinks.
 *
 * Supports `--json` (inherited from the root program) for machine-readable
 * output.
 *
 * @module commands/lint
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import type { Command } from 'commander';

import {
  detectStalePages,
  getUncompiledSources,
  type StalePageInfo,
  validateCompiledPage,
  type ValidationResult,
} from '@ico/compiler';
import { appendAuditLog, closeDatabase, initDatabase, writeTrace } from '@ico/kernel';

import {
  formatError,
  formatHeader,
  formatJSON,
  formatSuccess,
  formatWarning,
} from '../lib/output.js';

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
  issues: number;
}

// ---------------------------------------------------------------------------
// Wiki scanning
// ---------------------------------------------------------------------------

/**
 * Return the absolute paths of every `.md` file found in the scanned wiki
 * subdirectories. `.gitkeep` files are excluded.
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
  // Match [[slug]] or [[slug|alias]] — capture only the slug portion.
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
 * Detect wiki pages that have no incoming `[[slug]]` backlinks from any other
 * page in the wiki.
 *
 * Source-summary pages (wiki/sources/) are never considered orphans — they are
 * always the root of the provenance chain.
 *
 * @param wikiPath  - Absolute path to `wiki/`.
 * @param allPages  - Absolute paths of all scanned wiki pages.
 * @returns Paths of orphan pages, relative to the workspace root.
 */
export function detectOrphans(wikiPath: string, allPages: string[]): string[] {
  // Build the set of slugs referenced by any page.
  const referencedSlugs = new Set<string>();

  for (const pagePath of allPages) {
    let content: string;
    try {
      content = readFileSync(pagePath, 'utf-8');
    } catch {
      continue;
    }
    for (const slug of extractWikilinks(content)) {
      referencedSlugs.add(slug);
    }
  }

  // A page is an orphan when its slug (basename without .md) is not referenced
  // by any other page, AND it is not in the sources subdir (never-orphan rule),
  // AND it is not index.md.
  const sourcesDirPath = join(wikiPath, SOURCE_SUMMARY_SUBDIR);

  const orphans: string[] = [];

  for (const pagePath of allPages) {
    // index.md at the wiki root is never an orphan
    if (basename(pagePath) === 'index.md') continue;

    // Source summary pages are never orphans
    if (pagePath.startsWith(sourcesDirPath + '/') || pagePath.startsWith(sourcesDirPath + '\\')) {
      continue;
    }

    const slug = basename(pagePath, '.md');
    if (!referencedSlugs.has(slug)) {
      orphans.push(pagePath);
    }
  }

  return orphans;
}

// ---------------------------------------------------------------------------
// Core lint logic
// ---------------------------------------------------------------------------

/**
 * Run all lint checks against the workspace and return a `LintResult`.
 *
 * @param workspaceRoot - Absolute path to the workspace root.
 * @param dbPath        - Absolute path to `.ico/state.db`.
 * @returns The fully populated `LintResult`.
 * @throws When the database cannot be opened.
 */
export function runLint(workspaceRoot: string, dbPath: string): LintResult {
  const wikiPath = join(workspaceRoot, 'wiki');

  // --- 1. Schema validation -------------------------------------------------
  const allPages = scanWikiPages(wikiPath);
  const schemaErrors: SchemaError[] = [];
  let validCount = 0;

  for (const pagePath of allPages) {
    const result = validateCompiledPage(pagePath);
    if (!result.ok) {
      // I/O failure — treat as an invalid page
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
  // Emit `lint.run` + `lint.result` traces around the DB-backed work so the
  // audit layer records every lint pass per 011-AT-TRSC §6.19–6.20. The
  // correlation_id ties the two events together.
  const dbResult = initDatabase(dbPath);
  if (!dbResult.ok) {
    throw new Error(`Failed to open database: ${dbResult.error.message}`);
  }
  const db = dbResult.value;

  const lintCorrelationId = randomUUID();
  const lintRunStart = Date.now();

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

    // --- 5. Aggregate -------------------------------------------------------
    const issues =
      schemaErrors.length + stalePages.length + uncompiledSources.length + orphanPaths.length;

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
      issues,
    };

    // Per 011-AT-TRSC §6.20: lint.result payload includes `issues_found` and
    // an `issues` array of {path, severity, message}. Map our typed buckets
    // into that shape so the trace is queryable by external tools.
    const issuePayload = [
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
      `Lint reported ${issues} issue(s) across schema/staleness/uncompiled/orphans`,
    );
  } finally {
    closeDatabase(db);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Human-readable rendering
// ---------------------------------------------------------------------------

/**
 * Render a `LintResult` as a human-readable health report.
 *
 * @param result        - The lint result to render.
 * @param workspaceRoot - Workspace root used to produce relative paths.
 */
export function renderLintReport(result: LintResult, workspaceRoot: string): string {
  const lines: string[] = [];

  lines.push(formatHeader('Knowledge Health Report'));
  lines.push('');

  // Summary table
  const schemaStatus =
    result.schema.invalid === 0
      ? formatSuccess(`${result.schema.valid} pages valid`)
      : formatWarning(`${result.schema.invalid} schema violation(s)`);

  const stalenessStatus =
    result.staleness.stale === 0
      ? formatSuccess('all compilations current')
      : formatWarning(`${result.staleness.stale} stale page(s) need recompilation`);

  const uncompiledStatus =
    result.uncompiled.count === 0
      ? formatSuccess('0 uncompiled sources')
      : formatWarning(`${result.uncompiled.count} uncompiled source(s)`);

  const orphanStatus =
    result.orphans.count === 0
      ? formatSuccess('no orphan pages')
      : formatWarning(`${result.orphans.count} page(s) with no backlinks`);

  const pad = (label: string): string => `  ${label.padEnd(16)}`;

  lines.push(`${pad('Schema:')}${schemaStatus}`);
  lines.push(`${pad('Staleness:')}${stalenessStatus}`);
  lines.push(`${pad('Uncompiled:')}${uncompiledStatus}`);
  lines.push(`${pad('Orphans:')}${orphanStatus}`);
  lines.push('');

  if (result.issues === 0) {
    lines.push(formatSuccess('All checks passed'));
  } else {
    lines.push(
      result.issues === 1
        ? formatWarning('1 issue found')
        : formatWarning(`${result.issues} issues found`),
    );
  }

  // --- Schema violation details ---
  if (result.schema.errors.length > 0) {
    lines.push('');
    lines.push('  Schema violations:');
    for (const se of result.schema.errors) {
      const relPath = se.path.startsWith(workspaceRoot)
        ? se.path.slice(workspaceRoot.length).replace(/^[\\/]/, '')
        : se.path;
      lines.push(`    ${relPath}`);
      for (const e of se.errors) {
        lines.push(`      ${e}`);
      }
    }
  }

  // --- Stale page details ---
  if (result.staleness.stale > 0) {
    lines.push('');
    lines.push('  Stale pages:');
    for (const sp of result.staleness.pages) {
      lines.push(`    ${sp.outputPath} (${sp.reason})`);
    }
  }

  // --- Uncompiled source details ---
  if (result.uncompiled.count > 0) {
    lines.push('');
    lines.push('  Uncompiled sources:');
    for (const src of result.uncompiled.sources) {
      lines.push(`    ${src.path} (${src.type})`);
    }
  }

  // --- Orphan details ---
  if (result.orphans.count > 0) {
    lines.push('');
    lines.push('  Orphan pages:');
    for (const op of result.orphans.pages) {
      const relPath = op.startsWith(workspaceRoot)
        ? op.slice(workspaceRoot.length).replace(/^[\\/]/, '')
        : op;
      lines.push(`    ${relPath}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register `ico lint` onto the root Commander program.
 *
 * @param program - The root Commander `Command` instance.
 */
export function register(program: Command): void {
  program
    .command('lint')
    .description('Audit compiled knowledge for schema, staleness, and structural issues')
    .addHelpText(
      'after',
      '\nExamples:\n  $ ico lint\n  $ ico lint --json\n  $ ico lint --workspace /path/to/ws',
    )
    .action(() => {
      const globalOpts = program.opts<{ workspace?: string; json?: boolean }>();

      const wsPath = resolve(globalOpts.workspace ?? '.');
      const dbPath = join(wsPath, '.ico', 'state.db');

      let result: LintResult;
      try {
        result = runLint(wsPath, dbPath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(formatError(msg));
        process.exit(1);
      }

      if (globalOpts.json === true) {
        console.log(formatJSON(result));
        return;
      }

      console.log(renderLintReport(result, wsPath));

      if (result.issues > 0) {
        process.exitCode = 1;
      }
    });
}
