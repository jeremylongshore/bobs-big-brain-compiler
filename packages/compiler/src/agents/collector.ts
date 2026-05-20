/**
 * Collector agent for episodic research tasks (E9-B02).
 *
 * `collectEvidence()` is the first stage of the multi-agent research pipeline.
 * It reads a task's `brief.md`, searches the compiled wiki for relevant pages
 * via FTS5, copies each match to `tasks/tsk-<id>/evidence/NN-<slug>.md` with
 * source citations in the frontmatter, and transitions the task from
 * `created` to `collecting`.
 *
 * The module is pure — no Claude API calls. It operates entirely over the
 * deterministic kernel surface (search, tasks, traces).
 *
 * All functions return `Result<T, Error>` — never throw.
 *
 * @module agents/collector
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  type Database,
  getTask,
  searchPages,
  type SearchResult,
  type TaskRecord,
  transitionTask,
  writeTrace,
} from '@ico/kernel';
import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options controlling evidence collection scope. */
export interface CollectorOptions {
  /** Maximum wiki pages to search and copy. Defaults to 10. */
  maxResults?: number;
  /**
   * Maximum character count written to each evidence file body (excluding
   * frontmatter). Longer pages are truncated with a `[...truncated]` marker.
   * Defaults to 4000.
   */
  maxExcerptChars?: number;
}

/** Metadata for one evidence file produced by the Collector. */
export interface EvidenceFile {
  /** Relative path from workspace root (e.g. `tasks/tsk-abc/evidence/01-concepts-attention.md`). */
  path: string;
  /** Relative path to the source wiki page (e.g. `concepts/attention.md`). */
  sourcePath: string;
  /** Title of the source page (from frontmatter). */
  sourceTitle: string;
  /** FTS5 rank of the source match (lower is more relevant). */
  rank: number;
  /** Whether the body was truncated to fit `maxExcerptChars`. */
  truncated: boolean;
}

/** Result of a successful collection pass. */
export interface CollectorResult {
  taskId: string;
  /** Total pages that matched the brief in FTS5 search. */
  pagesMatched: number;
  /** Evidence files actually written (bounded by `maxResults`). */
  evidenceFiles: EvidenceFile[];
  /** New task status after transition. Always `'collecting'` on success. */
  newStatus: 'collecting';
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_MAX_EXCERPT_CHARS = 4000;
const TRUNCATION_MARKER = '\n\n[...truncated]\n';

/**
 * Stop words dropped before building the FTS5 query. Mirrors the set used in
 * kernel `findRelevantPages` but kept local to avoid exporting an internal
 * helper from the kernel's public surface.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'what',
  'which',
  'who',
  'whom',
  'whose',
  'when',
  'where',
  'why',
  'how',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'and',
  'or',
  'but',
  'not',
  'with',
  'from',
  'by',
  'as',
  'if',
  'so',
  'me',
  'my',
  'you',
  'your',
  'we',
  'our',
  'they',
  'their',
  'i',
  'define',
  'explain',
  'describe',
  'tell',
  'please',
  'give',
  'show',
  'also',
  'about',
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip YAML frontmatter from a markdown file and return the remaining body.
 * When the file does not start with `---`, the input is returned unchanged.
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const afterOpen = content.indexOf('\n') + 1;
  const closeIndex = content.indexOf('\n---', afterOpen);
  if (closeIndex === -1) return content;
  return content.slice(closeIndex + 4).trimStart();
}

/**
 * Build an FTS5 query from a natural-language brief by lower-casing, dropping
 * FTS5 operators, and filtering stop words. Hyphens are replaced with spaces
 * because FTS5 parses `a-b` as `a NOT b`. Tokens are joined with explicit
 * `OR` so the Collector casts a wide net — any wiki page matching at least
 * one meaningful term from the brief is a collection candidate. FTS5 still
 * ranks stronger matches (multiple-token hits, title hits) higher via BM25.
 *
 * Returns `null` when no searchable tokens remain.
 */
function buildFtsQuery(brief: string): string | null {
  const cleaned = brief.replace(/[-"*()^?!]/g, ' ').toLowerCase();
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/[^\w]/g, ''))
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return tokens.length > 0 ? tokens.join(' OR ') : null;
}

/**
 * Derive a filesystem-safe slug from a wiki-relative page path.
 * e.g. `concepts/self-attention.md` → `concepts-self-attention`.
 */
function slugifyPath(pagePath: string): string {
  return pagePath
    .replace(/\.md$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/**
 * Compose an evidence file's markdown content with YAML frontmatter that
 * cites the source and records collection metadata.
 */
function composeEvidenceFile(
  taskId: string,
  result: SearchResult,
  body: string,
  collectedAt: string,
  truncated: boolean,
): string {
  // YAML-safe quoting via JSON.stringify handles all special chars (quotes,
  // colons, backslashes, leading whitespace) — JSON string syntax is a strict
  // subset of YAML 1.2 flow scalar syntax.
  const fm = [
    '---',
    `task_id: ${taskId}`,
    `source_path: ${result.path}`,
    `source_title: ${JSON.stringify(result.title)}`,
    `source_type: ${result.type}`,
    `rank: ${result.rank}`,
    `collected_at: ${collectedAt}`,
    `truncated: ${truncated}`,
    '---',
    '',
  ].join('\n');
  return `${fm}${body}\n`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect evidence for a research task by searching compiled knowledge.
 *
 * Preconditions:
 * - The task exists and is in the `'created'` state. Any other state is an
 *   error — collection is the first transition and cannot run twice.
 * - `brief.md` exists at the task workspace root.
 * - The FTS5 index (`pages_fts`) has been built. Callers are expected to have
 *   invoked `indexCompiledPages` earlier in the session, or to have a
 *   previously indexed database.
 *
 * Behaviour:
 * 1. Reads the task row and its `brief.md` body.
 * 2. Builds a stop-word-filtered FTS5 query from the brief.
 * 3. Searches the wiki via `searchPages`.
 * 4. For each match (up to `maxResults`), reads the wiki page, truncates to
 *    `maxExcerptChars`, and writes `evidence/NN-<slug>.md` with frontmatter
 *    citing the source page.
 * 5. Emits one `evidence.collect` trace event per file.
 * 6. Transitions the task to `'collecting'` via `transitionTask`, which
 *    writes a `task.transition` trace.
 *
 * Failure modes (never throw; all return `err(Error)`):
 * - Task not found or not in `'created'` state.
 * - `brief.md` missing or unreadable.
 * - Brief contains no searchable terms after stop-word filtering.
 * - FTS5 search fails.
 * - Zero matching pages (task remains in `'created'` so the operator can
 *   refine the brief or add sources).
 * - Filesystem or transition errors.
 *
 * @param db            - Open better-sqlite3 database with migrations and FTS5 index.
 * @param workspacePath - Absolute path to the workspace root.
 * @param taskId        - UUID of a task in the `'created'` state.
 * @param options       - Optional limits; see {@link CollectorOptions}.
 * @returns `ok(CollectorResult)` on success, or `err(Error)` on any failure.
 */
export function collectEvidence(
  db: Database,
  workspacePath: string,
  taskId: string,
  options: CollectorOptions = {},
): Result<CollectorResult, Error> {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxExcerptChars = options.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;

  // 1. Look up the task row.
  const taskResult = getTask(db, taskId);
  if (!taskResult.ok) return err(taskResult.error);
  if (taskResult.value === null) {
    return err(new Error(`Task not found: ${taskId}`));
  }
  const task: TaskRecord = taskResult.value;

  if (task.status !== 'created') {
    return err(
      new Error(
        `Cannot collect evidence: task ${taskId} is in status '${task.status}', expected 'created'`,
      ),
    );
  }

  // 2. Read brief.md.
  const briefPath = resolve(workspacePath, task.workspace_path, 'brief.md');
  if (!existsSync(briefPath)) {
    return err(new Error(`Brief not found at ${briefPath}`));
  }

  let briefContent: string;
  try {
    briefContent = readFileSync(briefPath, 'utf-8');
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
  const briefText = stripFrontmatter(briefContent).trim();
  if (briefText === '') {
    return err(new Error(`Brief body is empty for task ${taskId}`));
  }

  // 3. Build FTS5 query from brief.
  const ftsQuery = buildFtsQuery(briefText);
  if (ftsQuery === null) {
    return err(new Error('Brief contains no searchable terms after stop-word filtering'));
  }

  // 4. Search compiled wiki.
  const searchResult = searchPages(db, ftsQuery, maxResults);
  if (!searchResult.ok) return err(searchResult.error);

  const matches = searchResult.value;
  if (matches.length === 0) {
    return err(
      new Error(
        `No matching pages found for brief. Task ${taskId} remains in 'created'. ` +
          `Consider refining the brief or compiling additional sources.`,
      ),
    );
  }

  // 5. Write one evidence file per match.
  const evidenceDir = resolve(workspacePath, task.workspace_path, 'evidence');
  const wikiRoot = resolve(workspacePath, 'wiki');
  const collectedAt = new Date().toISOString();
  const evidenceFiles: EvidenceFile[] = [];

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const wikiAbsPath = resolve(wikiRoot, match.path);

    let pageContent: string;
    try {
      pageContent = readFileSync(wikiAbsPath, 'utf-8');
    } catch (e) {
      return err(
        new Error(
          `Failed to read source page ${match.path}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }

    const body = stripFrontmatter(pageContent);
    const truncated = body.length > maxExcerptChars;
    const excerpt = truncated ? body.slice(0, maxExcerptChars) + TRUNCATION_MARKER : body;

    const idx = String(i + 1).padStart(2, '0');
    const filename = `${idx}-${slugifyPath(match.path)}.md`;
    const evidenceAbsPath = join(evidenceDir, filename);
    const evidenceRelPath = join(task.workspace_path, 'evidence', filename);

    const fileContent = composeEvidenceFile(taskId, match, excerpt, collectedAt, truncated);

    try {
      writeFileSync(evidenceAbsPath, fileContent, 'utf-8');
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }

    // Per-file trace event for auditability.
    const traceResult = writeTrace(db, workspacePath, 'evidence.collect', {
      taskId,
      sourcePath: match.path,
      sourceTitle: match.title,
      evidencePath: evidenceRelPath,
      rank: match.rank,
      truncated,
    });
    if (!traceResult.ok) return err(traceResult.error);

    evidenceFiles.push({
      path: evidenceRelPath,
      sourcePath: match.path,
      sourceTitle: match.title,
      rank: match.rank,
      truncated,
    });
  }

  // 6. Transition task: created → collecting (writes task.transition trace).
  const transitionResult = transitionTask(db, workspacePath, taskId, 'collecting');
  if (!transitionResult.ok) return err(transitionResult.error);

  return ok({
    taskId,
    pagesMatched: matches.length,
    evidenceFiles,
    newStatus: 'collecting',
  });
}
