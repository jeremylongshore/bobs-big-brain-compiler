/**
 * Functional-quality eval handler (E10, functional-quality eval type).
 *
 * Operationalizes a dogfood question-bank entry as a *deterministic* gate.
 * Given a natural-language `question` plus hand-authored ground truth
 * (`expected_substrings`, `expected_sources`), it measures two things over
 * the workspace's FTS5 retrieval:
 *
 *   - **source recall** = (expected_sources surfaced in the top-k retrieval) /
 *     (expected_sources total). Floored by `recall_floor`.
 *   - **substring grounding** = (expected_substrings present in the bodies of
 *     the top-k retrieved pages) / (expected_substrings total).
 *
 * The aggregate `score` is the mean of the two. The spec passes when
 * `score >= threshold` AND `source_recall >= recall_floor`.
 *
 * Why deterministic (no LLM): an eval that gates a ship decision must be
 * reproducible — the platform's whole thesis is signable, deterministic
 * evidence. This handler answers "does retrieval surface the right sources,
 * and do those sources actually contain the expected facts?" without a model
 * call, so it runs in CI for free with a stable verdict. The LLM
 * answer-synthesis variant of the same bank lives in the
 * `dogfood/experiments/compile-vs-rag` harness, not here.
 *
 * Unlike the `retrieval` handler (which only checks whether the right *page*
 * ranks in the top-k), functional-quality also reads the retrieved page
 * bodies and verifies they *contain* the expected facts — catching the
 * "right document retrieved, but the claimed fact isn't actually in it"
 * failure mode.
 *
 * @module evals/handlers/functional-quality
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';

import { searchPages } from '../../search.js';
import type { EvalResult, FunctionalQualityEvalSpec } from '../types.js';
import { buildOrQuery } from './retrieval.js';

const DEFAULT_K = 5;

/**
 * Read a retrieved page's body text from disk. The FTS5 table is
 * contentless (`content=''`), so grounding must read the source file.
 * `searchPages` returns wiki-relative paths (e.g. `concepts/foo.md`), so
 * the file lives under `<workspace>/wiki/<path>`. A missing/unreadable file
 * contributes no text rather than crashing the eval — the substring simply
 * won't be found there, which is the correct (conservative) grounding
 * outcome.
 */
function readPageText(workspacePath: string, pagePath: string): string {
  try {
    return readFileSync(join(workspacePath, 'wiki', pagePath), 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Does an expected source path match any retrieved page path? The bank's
 * `expected_sources` are authored as repo-relative paths (e.g. `CLAUDE.md`,
 * `000-docs/003-...md`), while the workspace stores ingested pages under its
 * own scheme (e.g. `raw/<src>/CLAUDE.md`, `wiki/sources/<slug>.md`). Match
 * conservatively: exact, path-suffix, or basename equality.
 */
function sourceMatches(expected: string, retrievedPaths: ReadonlyArray<string>): boolean {
  const e = expected.replace(/^\.?\/+/, '').toLowerCase();
  const eBase = basename(e);
  for (const p of retrievedPaths) {
    const rp = p.toLowerCase();
    if (rp === e || rp.endsWith(`/${e}`)) return true;
    if (eBase.length > 0 && basename(rp) === eBase) return true;
  }
  return false;
}

export function runFunctionalQualityEval(
  db: Database,
  workspacePath: string,
  spec: FunctionalQualityEvalSpec,
): Result<EvalResult, Error> {
  const start = Date.now();
  const k = spec.k ?? DEFAULT_K;
  const threshold = spec.threshold ?? 1;
  const recallFloor = spec.recall_floor ?? 0;

  const ftsQuery = buildOrQuery(spec.question);
  if (ftsQuery === null) {
    return ok({
      spec,
      passed: false,
      score: 0,
      threshold,
      details: `question '${spec.question}' has no searchable terms after stop-word filter`,
      durationMs: Date.now() - start,
    });
  }

  const hits = searchPages(db, ftsQuery, k);
  if (!hits.ok) return err(hits.error);
  const retrievedPaths = hits.value.map((r) => r.path);

  // Source recall: how many expected sources surfaced in the top-k.
  const foundSources: string[] = [];
  const missingSources: string[] = [];
  for (const src of spec.expected_sources) {
    if (sourceMatches(src, retrievedPaths)) foundSources.push(src);
    else missingSources.push(src);
  }
  const sourceRecall =
    spec.expected_sources.length === 0 ? 0 : foundSources.length / spec.expected_sources.length;

  // Substring grounding: are the expected facts present in the bodies of
  // the retrieved pages? Read each retrieved page once, lowercase, scan.
  const corpus = retrievedPaths
    .map((p) => readPageText(workspacePath, p))
    .join('\n')
    .toLowerCase();
  const groundedSubstrings: string[] = [];
  const ungroundedSubstrings: string[] = [];
  for (const sub of spec.expected_substrings) {
    if (corpus.includes(sub.toLowerCase())) groundedSubstrings.push(sub);
    else ungroundedSubstrings.push(sub);
  }
  const grounding =
    spec.expected_substrings.length === 0
      ? 0
      : groundedSubstrings.length / spec.expected_substrings.length;

  const score = (sourceRecall + grounding) / 2;
  const passed = score >= threshold && sourceRecall >= recallFloor;

  const metrics =
    `source_recall=${sourceRecall.toFixed(2)} ` +
    `grounding=${grounding.toFixed(2)} score=${score.toFixed(2)}`;
  const details = passed
    ? `${metrics} (>= ${threshold})`
    : `${metrics} (< ${threshold})` +
      (missingSources.length > 0 ? `; missing sources: ${missingSources.join(', ')}` : '') +
      (ungroundedSubstrings.length > 0 ? `; ungrounded: ${ungroundedSubstrings.join(', ')}` : '') +
      (sourceRecall < recallFloor ? `; recall floor ${recallFloor} violated` : '');

  return ok({
    spec,
    passed,
    score,
    threshold,
    details,
    durationMs: Date.now() - start,
  });
}
