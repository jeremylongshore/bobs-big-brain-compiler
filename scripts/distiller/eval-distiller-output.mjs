#!/usr/bin/env node
/**
 * eval-distiller-output.mjs — deterministic groundedness checks over one
 * night's distiller output (bead intentional-cognition-os-l13.9).
 *
 * WHAT IT CHECKS. The nightly distiller (scripts/distiller/teamkb-compile-daily.sh)
 * proposes candidates that the deterministic INTKB govern kernel admits. Each
 * promoted candidate in the night's decisions.jsonl record carries a
 * `qmd://<collection>/<file>.md` citation into the governed kb-export. This
 * harness verifies — with NO LLM, NO key, NO network — that each promoted
 * candidate is grounded in the material it cites:
 *
 *   1. citation      — present and well-formed (`qmd://<collection>/<name>.md`)
 *   2. source exists — the cited doc resolves to a real file under kb-export
 *                      (qmd://kb-decisions/x.md → <kb-export>/decisions/x.md)
 *   3. overlap       — the candidate's title content-words appear in the cited
 *                      doc's text at ≥ --min-overlap (default 0.5). A fabricated
 *                      title that shares no vocabulary with its cited source fails.
 *
 * A candidate scores 1 only when all three hold. The run score is the mean over
 * promoted candidates; exit 1 when score < --min-score (default 0.8).
 *
 * SHAPE. Mirrors the registrar eval-surface verdict pattern
 * (bobs-big-brain-registrar packages/eval-surface): a { passed, score, details }
 * verdict with every per-item finding DISCLOSED — no silent green, no false red.
 *
 * DEGRADE, NEVER CRASH. Missing decisions file, no record for the date, or a
 * record with zero promoted candidates → SKIP: logged reason, exit 0. Only a
 * genuine groundedness regression (or bad CLI usage) exits non-zero.
 *
 * Usage:
 *   node eval-distiller-output.mjs --decisions <decisions.jsonl> --date YYYY-MM-DD \
 *     --kb-export <dir> [--min-overlap 0.5] [--min-score 0.8] [--json]
 *
 * Exit codes: 0 pass or skip · 1 groundedness below --min-score · 2 usage error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Citation contract (versioned)
// ---------------------------------------------------------------------------
//
// The shape of a governed-brain citation is a CONTRACT between the distiller
// (which writes `qmd://…` citations into decisions.jsonl) and this harness
// (which resolves them). It is versioned so a reader can tell three failure
// modes apart FROM THE SUMMARY LINE ALONE:
//   - the MODEL broke        → low overlap on a valid, resolvable citation
//   - the HARNESS/contract    → malformed-citation across the board (format drift)
//   - the DATA moved          → missing-source across the board
// A format drift currently scores 0.0 and would otherwise read as a false
// quality regression; printing `citation format=<scheme> vN` in the summary
// makes "the harness broke" legible without opening the code. Bump
// CITATION_SCHEME_VERSION whenever CITATION_RE changes.
export const CITATION_SCHEME = 'qmd://<collection>/<name>.md';
export const CITATION_SCHEME_VERSION = 1;
/** The one regex that defines a well-formed citation. Single source of truth. */
const CITATION_RE = /^qmd:\/\/([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*\.md)$/;

// ---------------------------------------------------------------------------
// Scoring primitives (exported for the integration test)
// ---------------------------------------------------------------------------

/** Words carrying no groundedness signal — excluded from overlap. */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'her',
  'was',
  'one',
  'our',
  'out',
  'has',
  'have',
  'had',
  'this',
  'that',
  'with',
  'from',
  'they',
  'were',
  'been',
  'their',
  'its',
  'into',
  'than',
  'then',
  'them',
  'when',
  'what',
  'which',
  'while',
  'will',
  'would',
  'should',
  'could',
  'does',
  'only',
  'over',
  'under',
  'never',
  'always',
  'stays',
  'via',
  'per',
  'now',
]);

/**
 * Tokenize into lowercase content-words (>= 3 chars, stopwords removed).
 * Deterministic; digits and hyphenated fragments count (they are often the
 * load-bearing tokens in this estate: bead ids, doc codes, version numbers).
 */
export function contentWords(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter(
    (w) => !STOPWORDS.has(w),
  );
}

/**
 * Fraction of the title's UNIQUE content-words present in the source's
 * content-word set, in [0, 1]. A title with zero content-words is vacuously
 * grounded (1) — it asserts nothing checkable, mirroring the faithfulness
 * handler's "no assessable claims" rule.
 */
export function overlapRatio(title, sourceText) {
  const titleWords = [...new Set(contentWords(title))];
  if (titleWords.length === 0) return 1;
  const sourceSet = new Set(contentWords(sourceText));
  const hit = titleWords.filter((w) => sourceSet.has(w)).length;
  return hit / titleWords.length;
}

/**
 * Map a `qmd://<collection>/<name>.md` citation to a kb-export relative path.
 * The export drops the `kb-` prefix (qmd://kb-decisions/x.md → decisions/x.md);
 * un-prefixed collections map through as-is. Returns null on a malformed
 * citation (wrong scheme, path traversal, not a .md leaf).
 */
export function citationToRelPath(citation) {
  if (typeof citation !== 'string') return null;
  const m = citation.match(CITATION_RE);
  if (m === null) return null;
  const collection = m[1].startsWith('kb-') ? m[1].slice(3) : m[1];
  const name = m[2];
  if (name.includes('..')) return null;
  return join(collection, name);
}

/**
 * Score one candidate against the kb-export. Returns a disclosed finding:
 * { title, citation, check: 'ok'|'malformed-citation'|'missing-source'|'low-overlap',
 *   overlap, score }.
 */
export function scoreCandidate(candidate, kbExportDir, minOverlap) {
  const title = typeof candidate.title === 'string' ? candidate.title : '';
  const citation = typeof candidate.citation === 'string' ? candidate.citation : '';
  const base = { title, citation };

  const rel = citationToRelPath(citation);
  if (rel === null) return { ...base, check: 'malformed-citation', overlap: 0, score: 0 };

  const abs = resolve(kbExportDir, rel);
  if (!abs.startsWith(resolve(kbExportDir) + '/')) {
    return { ...base, check: 'malformed-citation', overlap: 0, score: 0 };
  }
  if (!existsSync(abs)) return { ...base, check: 'missing-source', overlap: 0, score: 0 };

  let sourceText;
  try {
    sourceText = readFileSync(abs, 'utf-8');
  } catch {
    return { ...base, check: 'missing-source', overlap: 0, score: 0 };
  }

  const overlap = overlapRatio(title, sourceText);
  if (overlap < minOverlap) return { ...base, check: 'low-overlap', overlap, score: 0 };
  return { ...base, check: 'ok', overlap, score: 1 };
}

/**
 * Evaluate one night's record. Returns the registrar-shaped verdict:
 * { skipped, reason?, passed, score, details: { date, promoted, findings } }.
 */
export function evaluateRecord(record, kbExportDir, { minOverlap = 0.5, minScore = 0.8 } = {}) {
  const candidates = Array.isArray(record?.candidates) ? record.candidates : [];
  const promoted = candidates.filter((c) => c?.disposition === 'promoted');
  if (promoted.length === 0) {
    return {
      skipped: true,
      reason: 'no promoted candidates in the record — nothing to ground',
      passed: true,
      score: 1,
      details: { date: record?.date ?? null, promoted: 0, findings: [] },
    };
  }
  const findings = promoted.map((c) => scoreCandidate(c, kbExportDir, minOverlap));
  const score = findings.reduce((acc, f) => acc + f.score, 0) / findings.length;
  return {
    skipped: false,
    passed: score >= minScore,
    score,
    details: { date: record?.date ?? null, promoted: promoted.length, findings },
  };
}

/**
 * Select the record for `date` from a decisions.jsonl body. The nightly
 * wrapper writes exactly one record per date, but the journal is append-only
 * and a re-run (or a manual replay) could append a SECOND same-date record.
 * "Last-wins" is the right choice (the newest run supersedes), but doing it
 * SILENTLY drops the earlier record's evidence — so we count matches and let
 * the caller warn. Walks every non-empty, parseable line; a corrupt line
 * elsewhere in the journal is skipped, never fatal.
 *
 * @returns {{ record: object|null, matchCount: number }} the final same-date
 *   record (or null) and how many same-date records were seen.
 */
export function selectRecordForDate(text, date) {
  let record = null;
  let matchCount = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    try {
      const r = JSON.parse(t);
      if (r?.date === date) {
        record = r; // last record for the date wins
        matchCount += 1;
      }
    } catch {
      // A corrupt line elsewhere in the journal must not kill tonight's eval.
    }
  }
  return { record, matchCount };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { minOverlap: 0.5, minScore: 0.8, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--decisions') args.decisions = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--kb-export') args.kbExport = argv[++i];
    else if (a === '--min-overlap') args.minOverlap = Number(argv[++i]);
    else if (a === '--min-score') args.minScore = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else return { error: `unknown argument: ${a}` };
  }
  if (!args.decisions || !args.date || !args.kbExport) {
    return { error: 'required: --decisions <file> --date YYYY-MM-DD --kb-export <dir>' };
  }
  if (!Number.isFinite(args.minOverlap) || !Number.isFinite(args.minScore)) {
    return { error: '--min-overlap and --min-score must be numbers' };
  }
  return { args };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`usage error: ${parsed.error}\n`);
    process.exit(2);
  }
  const { decisions, date, kbExport, minOverlap, minScore, json } = parsed.args;

  // Degrade-not-crash: every missing input is a logged SKIP, exit 0.
  if (!existsSync(decisions)) {
    process.stdout.write(`SKIP: decisions file missing (${decisions})\n`);
    process.exit(0);
  }
  if (!existsSync(kbExport)) {
    process.stdout.write(`SKIP: kb-export dir missing (${kbExport})\n`);
    process.exit(0);
  }

  const { record, matchCount } = selectRecordForDate(readFileSync(decisions, 'utf-8'), date);
  if (record === null) {
    process.stdout.write(`SKIP: no decisions record for ${date}\n`);
    process.exit(0);
  }
  if (matchCount > 1) {
    // Last-wins is intentional (newest run supersedes) but not silent: an
    // operator should know an earlier same-date record's evidence was dropped.
    process.stdout.write(
      `WARN: ${matchCount} decisions records for ${date} — scoring the LAST; earlier same-date records were superseded (last-wins).\n`,
    );
  }

  const verdict = evaluateRecord(record, kbExport, { minOverlap, minScore });
  if (json) {
    process.stdout.write(JSON.stringify(verdict, null, 2) + '\n');
  } else {
    for (const f of verdict.details.findings) {
      const mark = f.score === 1 ? 'ok ' : 'BAD';
      process.stdout.write(
        `  ${mark} [${f.check}] overlap=${f.overlap.toFixed(2)} ${f.title} → ${f.citation}\n`,
      );
    }
  }
  if (verdict.skipped) {
    process.stdout.write(`SKIP: ${verdict.reason}\n`);
    process.exit(0);
  }
  const grounded = verdict.details.findings.filter((f) => f.score === 1).length;
  // Surface how many candidates failed specifically on citation FORMAT — if
  // that count equals `promoted`, the contract drifted (harness broke), not the
  // model. The `citation format=` tag names the versioned scheme so a reader
  // can distinguish "the model broke" / "the harness broke" / "the data moved"
  // from this one line.
  const malformed = verdict.details.findings.filter((f) => f.check === 'malformed-citation').length;
  const formatNote =
    malformed === verdict.details.promoted && verdict.details.promoted > 0
      ? ` · ⚠ ALL citations malformed — likely CONTRACT drift, not a quality regression`
      : '';
  process.stdout.write(
    `grounded ${grounded}/${verdict.details.promoted} promoted candidates · score=${verdict.score.toFixed(2)} ${verdict.passed ? '>=' : '<'} ${minScore} (${verdict.passed ? 'PASS' : 'FAIL'}) · deterministic (citation+source+overlap>=${minOverlap}) · citation format=${CITATION_SCHEME} v${CITATION_SCHEME_VERSION}${formatNote}\n`,
  );
  process.exit(verdict.passed ? 0 : 1);
}

// Run only when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
