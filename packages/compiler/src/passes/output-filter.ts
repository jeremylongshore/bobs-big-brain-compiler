/**
 * Deterministic model-output validation for the five generative compiler
 * passes (summarize / extract / synthesize / contradict / gap).
 *
 * Before this module the passes wrote Claude output to the wiki verbatim —
 * `validateCompiledPage` ran only in the opt-in `ico lint`. The 2026-07-16
 * bulk digestion showed why that is not enough: the spool carried 48 "Empty
 * Source Document" pages and 134 refusal/junk candidates straight into the
 * govern queue (bead intentional-cognition-os-l13.1).
 *
 * Contract (receipts-precede-visibility, PR #176 discipline): a failed
 * validation SKIPS the write — the page never becomes visible — and the
 * rejection leaves a `compile.validation.reject` trace event so the skip is
 * receipted, never silent. The checks here are DETERMINISTIC only (string /
 * structure predicates); no model is ever asked to judge model output.
 *
 * @module passes/output-filter
 */

import { setFrontmatterField } from './batch-helper.js';

// ---------------------------------------------------------------------------
// Pass provenance stamping (l13.5)
// ---------------------------------------------------------------------------

/**
 * Version of the compile-pass contract stamped into every compiled page as
 * `pass_version`. Bump when a pass prompt (017-AT-PRMP) or the deterministic
 * write path changes in a way that alters page semantics. Carried page-side so
 * the spool emitter can lift it into candidate metadata without the passes and
 * the emitter having to agree on anything beyond frontmatter keys.
 */
export const COMPILE_PASS_VERSION = '1';

/**
 * Stamp deterministic pass-provenance frontmatter onto a compiled page:
 * `compiled_by` (the pass operation, e.g. `compile.summarize`) and
 * `pass_version`, plus any caller-supplied extra scalar fields (e.g. the
 * deterministic `source_path` / `content_hash` on a source summary).
 *
 * The deterministic write path owns these values — whatever the model emitted
 * for the same keys is overwritten. Unknown keys are ignored by the Zod
 * frontmatter schemas (they strip, not reject), so stamping never invalidates
 * a page.
 */
export function stampPassProvenance(
  content: string,
  pass: string,
  extra?: Record<string, string>,
): string {
  let out = setFrontmatterField(content, 'compiled_by', pass);
  out = setFrontmatterField(out, 'pass_version', COMPILE_PASS_VERSION);
  for (const [key, value] of Object.entries(extra ?? {})) {
    out = setFrontmatterField(out, key, value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic output checks (l13.1)
// ---------------------------------------------------------------------------

/** Machine-readable reason a model output was rejected. */
export type OutputRejectCode =
  | 'EMPTY_OUTPUT'
  | 'REFUSAL_DETECTED'
  | 'BODY_TOO_SHORT'
  | 'NON_MARKDOWN_JUNK';

/** A single rejection finding, receipted via a `compile.validation.reject` trace. */
export interface OutputRejection {
  code: OutputRejectCode;
  detail: string;
  /** First 120 chars of the offending output, for the trace payload. */
  excerpt: string;
}

/** Result of `checkModelOutput`. */
export type OutputCheckResult = { ok: true } | { ok: false; rejection: OutputRejection };

/**
 * Refusal boilerplate openers. Matched case-insensitively against the START
 * of the output (first {@link REFUSAL_WINDOW_CHARS} chars) and ONLY when the
 * output does not open with a `---` frontmatter fence — a model that complied
 * with the page format is by construction not refusing, and quoted source
 * text deeper in a page body must never trip the filter.
 */
const REFUSAL_PATTERNS: readonly RegExp[] = [
  /\bi\s+cannot\b/i,
  /\bi\s+can['’]t\b/i,
  /\bi\s+am\s+unable\b/i,
  /\bi['’]m\s+unable\b/i,
  /\bi\s+won['’]t\b/i,
  /\bi\s+will\s+not\b/i,
  /\bas\s+an\s+ai\b/i,
  /\bi\s+apologi[sz]e\b/i,
  /\bi['’]m\s+sorry\b/i,
  /\bi\s+am\s+sorry\b/i,
  /\bi\s+don['’]t\s+have\s+(?:the\s+ability|access)\b/i,
];

const REFUSAL_WINDOW_CHARS = 300;

/**
 * Default minimum body length (chars, post-frontmatter) for a compiled page.
 * Deliberately a DEGENERATE-output floor, not a quality bar: page types like
 * contradictions carry their claims in frontmatter and legitimately ship
 * one-line bodies. 20 chars rejects empty / single-word husks while letting
 * every claim-bearing page through.
 */
export const DEFAULT_MIN_BODY_CHARS = 20;

/**
 * Strip a leading `---` … `---` frontmatter fence, returning the body.
 *
 * Uses plain `indexOf` scanning rather than a regex: a `\s*\n … \n---`
 * pattern backtracks polynomially on adversarial newline runs (CodeQL
 * `js/polynomial-redos`), and this input is untrusted model output.
 */
function stripFrontmatter(trimmed: string): string {
  if (!trimmed.startsWith('---')) return trimmed;
  // Find the first line break after the opening fence, then the closing
  // `\n---` fence line. Linear scan, no backtracking.
  const afterOpen = trimmed.indexOf('\n');
  if (afterOpen === -1) return '';
  const closeIdx = trimmed.indexOf('\n---', afterOpen);
  if (closeIdx === -1) return '';
  // Advance past the closing fence line to the start of the body.
  const bodyStart = trimmed.indexOf('\n', closeIdx + 1);
  return bodyStart === -1 ? '' : trimmed.slice(bodyStart + 1);
}

/** True when the content carries any recognisable page structure. */
function hasStructuralSignal(trimmed: string): boolean {
  if (trimmed.startsWith('---')) return true; // frontmatter fence
  if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/m.test(trimmed)) return true; // YAML-ish key line
  if (/^#{1,6}\s+\S/m.test(trimmed)) return true; // markdown heading
  return false;
}

/**
 * Deterministically validate one model-emitted page (or whole single-page
 * response) BEFORE it is written anywhere.
 *
 * Checks, in order:
 *  1. `EMPTY_OUTPUT` — nothing but whitespace.
 *  2. `REFUSAL_DETECTED` — refusal boilerplate ("I cannot…", "As an AI…")
 *     at the start of an un-fenced output.
 *  3. `NON_MARKDOWN_JUNK` — no frontmatter fence, no YAML key line, and no
 *     markdown heading anywhere: prose/JSON junk that is not a page.
 *  4. `BODY_TOO_SHORT` — the post-frontmatter body is under `minBodyChars`
 *     (default {@link DEFAULT_MIN_BODY_CHARS}) — the "Empty Source Document"
 *     shape from the 07-16 spool.
 */
export function checkModelOutput(
  content: string,
  options?: { minBodyChars?: number },
): OutputCheckResult {
  const minBodyChars = options?.minBodyChars ?? DEFAULT_MIN_BODY_CHARS;
  const trimmed = content.trim();
  const excerpt = trimmed.slice(0, 120);

  if (trimmed === '') {
    return {
      ok: false,
      rejection: { code: 'EMPTY_OUTPUT', detail: 'model output is empty', excerpt },
    };
  }

  if (!trimmed.startsWith('---')) {
    const window = trimmed.slice(0, REFUSAL_WINDOW_CHARS);
    const hit = REFUSAL_PATTERNS.find((p) => p.test(window));
    if (hit !== undefined) {
      return {
        ok: false,
        rejection: {
          code: 'REFUSAL_DETECTED',
          detail: `refusal boilerplate matched ${String(hit)} in the first ${REFUSAL_WINDOW_CHARS} chars of an un-fenced output`,
          excerpt,
        },
      };
    }
  }

  if (!hasStructuralSignal(trimmed)) {
    return {
      ok: false,
      rejection: {
        code: 'NON_MARKDOWN_JUNK',
        detail: 'no frontmatter fence, YAML key line, or markdown heading anywhere in the output',
        excerpt,
      },
    };
  }

  const body = stripFrontmatter(trimmed).trim();
  if (body.length < minBodyChars) {
    return {
      ok: false,
      rejection: {
        code: 'BODY_TOO_SHORT',
        detail: `post-frontmatter body is ${body.length} chars (< ${minBodyChars} minimum)`,
        excerpt,
      },
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Typed skip error (summarize path)
// ---------------------------------------------------------------------------

/**
 * A per-source compile skip that is NOT a failure: the source (or its model
 * output) failed deterministic validation and the write was skipped with a
 * receipted trace. The CLI counts these separately from hard failures so an
 * all-skipped run is not misreported as an API outage.
 */
export class CompileSkipError extends Error {
  constructor(
    public readonly code: OutputRejectCode | 'EMPTY_SOURCE',
    message: string,
  ) {
    super(message);
    this.name = 'CompileSkipError';
  }
}
