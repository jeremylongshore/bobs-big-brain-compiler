/**
 * Link pass — adds backlink sections to compiled wiki pages.
 *
 * This pass is primarily deterministic:
 *   1. Scan all compiled pages in wiki/ subdirectories.
 *   2. Build a reference graph using [[page-name]] wiki-link syntax.
 *   3. For each page that is referenced by others, append a ## Backlinks section.
 *   4. Write updated pages atomically.
 *   5. Insert compilation records, record provenance, write traces, append audit logs.
 *
 * Never throws — all error paths return err(Error).
 */

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

import { appendAuditLog, type Database, writeTrace } from '@ico/kernel';
import { err, ok, type Result } from '@ico/types';

import type { ClaudeClient } from '../api/claude-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Wiki subdirectories to scan for compiled pages. */
const WIKI_SUBDIRS = [
  'sources',
  'concepts',
  'entities',
  'topics',
  'contradictions',
  'open-questions',
] as const;

const BACKLINK_SECTION_MARKER = '## Backlinks';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Optional overrides for the link pass. */
export interface LinkOptions {
  /** Model parameter accepted for interface consistency — not used in the deterministic path. */
  model?: string;
}

/** Summary of the link pass outcome. */
export interface LinkResult {
  /** Number of pages that had backlinks added or updated. */
  pagesUpdated: number;
  /** Total number of backlink relationships found. */
  totalBacklinks: number;
  /** ISO 8601 timestamp when the pass ran. */
  compiledAt: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PageInfo {
  /** Relative path from workspace root (e.g. wiki/concepts/foo.md). */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Page slug derived from the filename stem. */
  slug: string;
  /** Full file content. */
  content: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .md files under a wiki subdirectory.
 * Returns empty array if the directory does not exist.
 */
function collectPages(workspacePath: string, subdir: string): PageInfo[] {
  const dir = join(workspacePath, 'wiki', subdir);
  if (!existsSync(dir)) return [];

  const pages: PageInfo[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.md')) continue;
      const absPath = join(dir, entry);
      const relPath = relative(workspacePath, absPath);
      const slug = basename(entry, extname(entry));
      try {
        const content = readFileSync(absPath, 'utf-8');
        pages.push({ relPath, absPath, slug, content });
      } catch {
        // Skip unreadable files.
      }
    }
  } catch {
    // Skip unreadable directories.
  }
  return pages;
}

/**
 * Extract all [[slug]] references from a page's content.
 * Only the content portion after the frontmatter is scanned.
 */
function extractReferences(content: string): Set<string> {
  // Strip YAML frontmatter if present.
  const bodyStart = content.startsWith('---') ? content.indexOf('---', 3) + 3 : 0;
  const body = content.slice(bodyStart);

  const refs = new Set<string>();
  const wikiLinkPattern = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = wikiLinkPattern.exec(body)) !== null) {
    const ref = match[1];
    if (ref !== undefined) {
      refs.add(
        ref
          .toLowerCase()
          .replace(/[\s_]+/g, '-')
          .replace(/[^a-z0-9-]/g, '')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, ''),
      );
    }
  }
  return refs;
}

/**
 * Strip any existing ## Backlinks section from the page content.
 * This prevents duplicate backlinks on re-runs.
 */
function stripBacklinksSection(content: string): string {
  const idx = content.indexOf(`\n${BACKLINK_SECTION_MARKER}`);
  if (idx === -1) return content;
  return content.slice(0, idx);
}

/**
 * Build the ## Backlinks section markdown for a page.
 */
function buildBacklinksSection(referrers: PageInfo[]): string {
  const items = referrers.map((p) => `- [[${p.slug}]] (${p.relPath})`).join('\n');
  return `\n${BACKLINK_SECTION_MARKER}\n\n${items}\n`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the link compilation pass.
 *
 * Scans all compiled wiki pages, builds a reference graph from [[wiki-link]]
 * syntax, and appends a ## Backlinks section to any page that is referenced
 * by at least one other page. Existing backlink sections are replaced.
 *
 * The `client` parameter is accepted for interface consistency with other
 * passes but is not used — the link pass is fully deterministic.
 *
 * @param client        - Claude client (unused in this pass).
 * @param db            - Open better-sqlite3 database with migrations applied.
 * @param workspacePath - Absolute path to the workspace root directory.
 * @param options       - Optional overrides (model accepted but unused).
 * @returns `ok(LinkResult)` on success, `err(Error)` on any failure.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function addBacklinks(
  _client: ClaudeClient,
  db: Database,
  workspacePath: string,
  options?: LinkOptions,
): Promise<Result<LinkResult, Error>> {
  void options; // accepted for interface consistency

  const compiledAt = new Date().toISOString();

  // 1. Collect all wiki pages.
  const allPages: PageInfo[] = [];
  for (const subdir of WIKI_SUBDIRS) {
    allPages.push(...collectPages(workspacePath, subdir));
  }

  if (allPages.length === 0) {
    return ok({ pagesUpdated: 0, totalBacklinks: 0, compiledAt });
  }

  // 2. Build forward reference map: slug → set of slugs it references.
  const forwardRefs = new Map<string, Set<string>>();
  for (const page of allPages) {
    forwardRefs.set(page.slug, extractReferences(page.content));
  }

  // 3. Build reverse reference map: slug → pages that reference it.
  const backRefs = new Map<string, PageInfo[]>();
  for (const page of allPages) {
    const refs = forwardRefs.get(page.slug) ?? new Set();
    for (const ref of refs) {
      const existing = backRefs.get(ref) ?? [];
      existing.push(page);
      backRefs.set(ref, existing);
    }
  }

  // 4. Update pages that have incoming backlinks.
  let pagesUpdated = 0;
  let totalBacklinks = 0;

  for (const page of allPages) {
    const referrers = backRefs.get(page.slug);
    if (referrers === undefined || referrers.length === 0) continue;

    totalBacklinks += referrers.length;

    const cleanContent = stripBacklinksSection(page.content);
    const newContent = cleanContent + buildBacklinksSection(referrers);

    // 5. Atomic write (in-place update — no new compilation artifact).
    const tmpPath = `${page.absPath}.tmp`;
    try {
      writeFileSync(tmpPath, newContent, 'utf-8');
      renameSync(tmpPath, page.absPath);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }

    pagesUpdated++;
  }

  // 6. Write a single trace event for the whole pass.
  if (pagesUpdated > 0) {
    const traceResult = writeTrace(db, workspacePath, 'compile.link', {
      pagesUpdated,
      totalBacklinks,
    });
    if (!traceResult.ok) {
      return err(traceResult.error);
    }
  }

  // 8. Append single audit log entry for the entire pass.
  const auditResult = appendAuditLog(
    workspacePath,
    'compile.link',
    `Added backlinks to ${pagesUpdated} pages (${totalBacklinks} total links)`,
  );
  if (!auditResult.ok) {
    return err(auditResult.error);
  }

  return ok({ pagesUpdated, totalBacklinks, compiledAt });
}
