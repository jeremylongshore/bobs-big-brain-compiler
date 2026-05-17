/**
 * Citation-fidelity eval handler (E10-B03).
 *
 * Reads a markdown artifact (a rendered report, a research-task output,
 * a compiled wiki page, etc.) and extracts every inline citation
 * marker, then asserts each cited target maps to a real page in the
 * workspace `wiki/`. The eval catches hallucinated citations — the
 * single highest-cost failure mode of an LLM-grounded knowledge
 * system, per the master blueprint §5.4.
 *
 * Two citation marker formats are recognised:
 *   1. `[source: <title>]` — the `ico ask` convention (titles map to
 *      wiki pages by frontmatter `title:` field).
 *   2. `[[slug]]` — the wikilink convention (slug maps to a wiki page
 *      filename without extension).
 *
 * For each citation:
 *   - Title-form: walk `wiki/` looking for a file whose frontmatter
 *     `title:` matches. Cache the title→path map so a multi-citation
 *     artifact only walks once.
 *   - Slug-form: check `wiki/*\/<slug>.md` across the six standard
 *     subdirectories.
 *
 * Score = verified / total. Pass when score ≥ threshold (default 1.0
 * = zero hallucinations tolerated). When `expected_citations` is set,
 * the handler additionally fails if any expected target is absent from
 * the artifact (catches the inverse failure: under-citation).
 *
 * Pure-kernel — no Claude. Works with any markdown artifact.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';

import type { CitationEvalSpec, EvalResult } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Wiki subdirectories scanned when resolving citations. */
const WIKI_SUBDIRS = [
  'sources',
  'concepts',
  'entities',
  'topics',
  'contradictions',
  'open-questions',
] as const;

/** Regex for `[source: Title Here]` markers. */
const SOURCE_RE = /\[source:\s*([^\]]+?)\s*\]/g;

/** Regex for `[[slug]]` wikilinks (optionally with `|alias`). */
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]+)?]]/g;

// ---------------------------------------------------------------------------
// Title → path lookup
// ---------------------------------------------------------------------------

/**
 * Walk `wiki/` once and build maps from:
 *   - lowercased frontmatter title → relative path
 *   - lowercased basename (no extension) → relative path
 *
 * Returns both so the citation extractor can resolve either marker
 * style. Title matching is case-insensitive to tolerate minor casing
 * drift between the cited string and the canonical frontmatter title.
 */
interface WikiIndex {
  byTitle: Map<string, string>;
  bySlug: Map<string, string>;
}

function buildWikiIndex(workspacePath: string): WikiIndex {
  const byTitle = new Map<string, string>();
  const bySlug = new Map<string, string>();
  const wikiRoot = resolve(workspacePath, 'wiki');
  if (!existsSync(wikiRoot)) return { byTitle, bySlug };

  for (const subdir of WIKI_SUBDIRS) {
    const dirPath = resolve(wikiRoot, subdir);
    if (!existsSync(dirPath)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dirPath).filter((f) => f.endsWith('.md') && f !== '.gitkeep');
    } catch {
      continue;
    }
    for (const f of entries) {
      const relPath = `${subdir}/${f}`;
      const slug = basename(f, '.md').toLowerCase();
      bySlug.set(slug, relPath);

      // Best-effort frontmatter title parse — same naive scan the search
      // index uses; no need to pull in gray-matter for this.
      let content: string;
      try {
        content = readFileSync(resolve(dirPath, f), 'utf-8');
      } catch {
        continue;
      }
      const titleMatch = /^title:\s*(.+)$/m.exec(content);
      if (titleMatch !== null) {
        const title = titleMatch[1]!.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
        if (title !== '') byTitle.set(title, relPath);
      }
    }
  }
  return { byTitle, bySlug };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single citation discovered in the artifact. */
interface ExtractedCitation {
  /** Original marker text (e.g. `[source: Self-Attention]`). */
  marker: string;
  /** Normalized target — title or slug — used to look up the page. */
  target: string;
  /** Citation form. */
  kind: 'source' | 'wikilink';
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function extractCitations(body: string): ExtractedCitation[] {
  const out: ExtractedCitation[] = [];
  let m: RegExpExecArray | null;
  while ((m = SOURCE_RE.exec(body)) !== null) {
    out.push({ marker: m[0], target: m[1]!.trim(), kind: 'source' });
  }
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    const target = m[1]!.trim();
    // Skip empty wikilinks and standard markdown reference styles that
    // happen to look similar. The regex already filters most.
    if (target !== '') {
      out.push({ marker: m[0], target, kind: 'wikilink' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the citation-fidelity eval against `spec.target_file` (workspace-
 * relative). Reads the file, extracts citations, looks each up in the
 * wiki index, and reports verified vs hallucinated.
 *
 * Failure modes (never throw):
 * - target_file missing or unreadable
 * - zero citations found AND `require_citations` true (operator opt-in)
 * - any expected_citation missing from the artifact (with `expected_citations`)
 */
export function runCitationEval(
  _db: Database,
  workspacePath: string,
  spec: CitationEvalSpec,
): Result<EvalResult, Error> {
  const start = Date.now();
  const threshold = spec.threshold ?? 1;

  const absTarget = resolve(workspacePath, spec.target_file);
  // Path-traversal guard. Eval specs are untrusted YAML; without this,
  // `target_file: ../../etc/passwd` would read sensitive files outside
  // the workspace. Same shape as the guard B05 added on B11's recall-
  // export `--out` and the B02 fix on compilation `target_page`.
  const wsAbs = resolve(workspacePath);
  const wsPrefix = wsAbs.endsWith('/') ? wsAbs : `${wsAbs}/`;
  if (absTarget !== wsAbs && !absTarget.startsWith(wsPrefix)) {
    return err(
      new Error(
        `Citation eval '${spec.id}': target_file must stay inside the workspace (got ${spec.target_file})`,
      ),
    );
  }
  if (!existsSync(absTarget)) {
    return err(
      new Error(`Citation eval '${spec.id}': target_file not found at ${spec.target_file}`),
    );
  }
  let content: string;
  try {
    content = readFileSync(absTarget, 'utf-8');
  } catch (e) {
    return err(
      new Error(
        `Citation eval '${spec.id}': failed to read target_file: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  const citations = extractCitations(content);
  const expectedCitations = spec.expected_citations ?? [];
  const requireCitations = spec.require_citations ?? false;

  // The zero-citation case used to early-return without consulting
  // `expected_citations`. That hid under-grounding: an artifact with no
  // citations and `expected_citations: [...]` should fail. We always
  // walk through the verify/missing logic now; the zero-citation case
  // just gets score=1 (no hallucinations to count) and may still fail
  // on require_citations or missing-expected checks below.
  const idx = buildWikiIndex(workspacePath);

  const verified: ExtractedCitation[] = [];
  const hallucinated: ExtractedCitation[] = [];
  // Track the set of resolved wiki paths so we can check expected_citations.
  const resolvedPaths = new Set<string>();
  for (const c of citations) {
    const lookup =
      c.kind === 'source'
        ? idx.byTitle.get(c.target.toLowerCase())
        : idx.bySlug.get(c.target.toLowerCase());
    if (lookup !== undefined) {
      verified.push(c);
      resolvedPaths.add(lookup);
    } else {
      hallucinated.push(c);
    }
  }

  // Score = verified / total. Zero-citation case is 1.0 (no hallucinations
  // to count) — guarding against NaN. require_citations and
  // expected_citations checks below can still fail the eval.
  const score = citations.length === 0 ? 1 : verified.length / citations.length;

  // Inverse check: every expected citation must be present in the
  // artifact's resolved citation set.
  const missingExpected = expectedCitations.filter((exp) => !resolvedPaths.has(exp));

  // require_citations forces a fail when the artifact had zero citations.
  const zeroFail = requireCitations && citations.length === 0;

  const passed = !zeroFail && score >= threshold && missingExpected.length === 0;

  const halParts =
    hallucinated.length > 0
      ? `; hallucinated: ${hallucinated.map((h) => h.marker).join(', ')}`
      : '';
  const missParts =
    missingExpected.length > 0 ? `; missing expected: ${missingExpected.join(', ')}` : '';
  const zeroParts =
    citations.length === 0
      ? requireCitations
        ? ' (zero citations but require_citations=true)'
        : ' (zero citations, vacuously verified)'
      : '';
  const details = `${verified.length}/${citations.length} citations verified (score=${score.toFixed(2)})${zeroParts}${halParts}${missParts}`;

  return ok({
    spec,
    passed,
    score,
    threshold,
    details,
    durationMs: Date.now() - start,
  });
}
