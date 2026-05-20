/**
 * Question analysis for the `ico ask` pipeline (E7-B02).
 *
 * Classifies the user's question by type, retrieves relevant compiled pages
 * from the FTS5 index, and signals whether the question is too complex for
 * a direct answer and should be escalated to `ico research`.
 *
 * Never throws — all error paths return err(Error).
 */

import type { Database } from '@ico/kernel';
import { searchPages, type SearchResult } from '@ico/kernel';
import { err, ok, type Result } from '@ico/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Coarse classification of question intent. */
export type QuestionType = 'factual' | 'comparative' | 'analytical' | 'open-ended';

/** Result of analysing a user question prior to answer generation. */
export interface QuestionAnalysis {
  /** The original question string, unmodified. */
  originalQuestion: string;
  /** Coarse classification of the question's intent. */
  type: QuestionType;
  /** Compiled pages retrieved from the FTS5 index that are relevant to the question. */
  relevantPages: SearchResult[];
  /**
   * True when the question appears too complex for a direct `ask` answer and
   * would benefit from a structured `ico research` workspace instead.
   */
  suggestResearch: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Keywords that signal each question type, checked in order.
 * The first matching type wins; `open-ended` is the fallback.
 */
const TYPE_RULES: ReadonlyArray<{ type: QuestionType; patterns: ReadonlyArray<RegExp> }> = [
  {
    type: 'comparative',
    patterns: [/\bcompare\b/i, /\bvs\.?\b/i, /\bdifference\b/i, /\bdifferences\b/i, /\bversus\b/i],
  },
  {
    type: 'analytical',
    patterns: [/\bwhy\b/i, /\bhow does\b/i, /\bexplain\b/i, /\banalyze\b/i, /\banalyse\b/i],
  },
  {
    type: 'factual',
    patterns: [
      /\bwhat is\b/i,
      /\bwhat are\b/i,
      /\bdefine\b/i,
      /\bdefinition\b/i,
      /\bwhen\b/i,
      /\bwhere\b/i,
      /\bwho\b/i,
    ],
  },
];

/**
 * Patterns that indicate a question contains multiple sub-questions,
 * suggesting the caller should escalate to `ico research`.
 */
const COMPLEXITY_PATTERNS: ReadonlyArray<RegExp> = [
  /\band also\b/i,
  /\badditionally\b/i,
  /\bfurthermore\b/i,
  /\bmoreover\b/i,
  /\bas well as\b/i,
];

/**
 * Classify a question into one of the four canonical {@link QuestionType} values.
 *
 * Checks type-specific keyword patterns in priority order:
 * comparative → analytical → factual → open-ended.
 */
function classifyQuestion(question: string): QuestionType {
  for (const rule of TYPE_RULES) {
    if (rule.patterns.some((p) => p.test(question))) {
      return rule.type;
    }
  }
  return 'open-ended';
}

/**
 * Return true when the question matches any complexity indicator pattern,
 * signalling that multiple sub-questions are present.
 */
function detectComplexity(question: string): boolean {
  return COMPLEXITY_PATTERNS.some((p) => p.test(question));
}

// ---------------------------------------------------------------------------
// FTS5 query preparation
// ---------------------------------------------------------------------------

/**
 * Common English words that are not content-bearing for FTS5 search.
 * Including these in a multi-word query causes FTS5 to require all tokens to
 * be present, which eliminates results when question words like "what" or "is"
 * do not appear in wiki page bodies.
 */
const STOP_WORDS = new Set([
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
  'need',
  'dare',
  'ought',
  'used',
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
  'yet',
  'both',
  'either',
  'neither',
  'whether',
  'about',
  'above',
  'across',
  'after',
  'against',
  'along',
  'among',
  'around',
  'before',
  'behind',
  'below',
  'beneath',
  'beside',
  'between',
  'beyond',
  'during',
  'into',
  'near',
  'off',
  'out',
  'over',
  'through',
  'under',
  'until',
  'up',
  'upon',
  'within',
  'without',
  'also',
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
]);

/**
 * Prepare a question string as an FTS5 query.
 *
 * Steps:
 *   1. Strip FTS5 special characters and replace hyphens with spaces
 *      (hyphens are parsed as boolean NOT by FTS5: `a-b` → `a NOT b`).
 *   2. Lowercase and split on whitespace.
 *   3. Remove stop words and tokens shorter than 2 characters.
 *   4. Join remaining tokens with spaces (FTS5 implicit AND).
 *
 * Returns `null` when no content tokens remain after filtering.
 */
function buildFtsQuery(question: string): string | null {
  // Replace hyphens and other FTS5 operators/punctuation with spaces.
  const cleaned = question.replace(/[-"*()^?!]/g, ' ').toLowerCase();
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/[^\w]/g, '')) // keep only word chars
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  if (tokens.length === 0) {
    return null;
  }

  return tokens.join(' ');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse a user question by classifying its type and retrieving relevant
 * compiled pages from the FTS5 search index.
 *
 * The FTS5 index must already exist and be populated (call
 * `createSearchIndex` + `indexCompiledPages` before this function).
 * If the index is empty or the query returns no rows, `relevantPages` will
 * be an empty array — the caller is responsible for handling the no-results
 * case.
 *
 * @param db             - Open better-sqlite3 database with FTS5 table present.
 * @param _workspacePath - Absolute path to the workspace root (reserved for
 *                         future filesystem-level enrichment steps).
 * @param question       - The raw user question string.
 * @returns `ok(QuestionAnalysis)` on success, or `err(Error)` if the FTS5
 *          query fails.
 */
export function analyzeQuestion(
  db: Database,
  _workspacePath: string,
  question: string,
): Result<QuestionAnalysis, Error> {
  const ftsQuery = buildFtsQuery(question);

  if (ftsQuery === null) {
    return err(new Error('Question contains no searchable terms after stop-word removal'));
  }

  const searchResult = searchPages(db, ftsQuery, 10);
  if (!searchResult.ok) {
    // FTS5 may throw on malformed queries; surface a friendly error.
    return err(new Error(`Search failed: ${searchResult.error.message}`));
  }

  const type = classifyQuestion(question);
  const suggestResearch = detectComplexity(question);

  return ok({
    originalQuestion: question,
    type,
    relevantPages: searchResult.value,
    suggestResearch,
  });
}
