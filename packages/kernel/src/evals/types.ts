/**
 * Eval framework type definitions (E10-B01).
 *
 * An "eval" is a YAML spec that drives a deterministic check against a
 * workspace and produces a pass/fail with an optional 0..1 score. Specs
 * live under `evals/` (workspace-relative); each is identified by `id`
 * and dispatched to a handler by `type`.
 *
 * Two handler types ship in B01:
 *   - `retrieval`: runs FTS5 search and scores recall@k / precision@k
 *     against an expected-pages list.
 *   - `smoke`: deterministic invariants over the workspace state (e.g.
 *     "FTS5 index is non-empty", "no tasks in failed_*").
 *
 * Later beads will add `compilation` (B02) and `citation` (B03)
 * handlers. The spec schema is intentionally permissive on extra fields
 * so new handlers can land without breaking existing specs.
 *
 * @module evals/types
 */

// ---------------------------------------------------------------------------
// Spec schema
// ---------------------------------------------------------------------------

/** Supported handler types. New handlers add to this union. */
export type EvalType = 'retrieval' | 'smoke' | 'compilation' | 'citation';

/** Common fields shared by every eval spec. */
export interface BaseEvalSpec {
  /** Stable identifier, e.g. `eval-retrieval-attention-001`. Unique per repo. */
  id: string;
  /** Human-readable name shown in reports. */
  name: string;
  /** Free-text purpose for future maintainers. */
  description?: string;
  /** Handler dispatch key. */
  type: EvalType;
  /** Optional target hint surfaced in the `eval.run` trace payload. */
  target?: string;
  /** Pass-threshold for the score in `[0, 1]`. Defaults to 1.0 (strict). */
  threshold?: number;
}

/** Retrieval handler — measures recall@k + precision@k against an expected page list. */
export interface RetrievalEvalSpec extends BaseEvalSpec {
  type: 'retrieval';
  /** Natural-language question fed into FTS5. */
  question: string;
  /** Wiki-relative paths that should appear in the top-k results. */
  expected_pages: string[];
  /** How many top results to consider. Defaults to 5. */
  k?: number;
  /**
   * Per-metric floors (B03). When set, the spec only passes if both the
   * aggregate `score >= threshold` AND `recall@k >= min_recall` AND
   * `precision@k >= min_precision`. Defaults to 0 (no floor).
   */
  min_recall?: number;
  min_precision?: number;
}

/** Smoke handler — boolean invariants the runner asserts. */
export interface SmokeEvalSpec extends BaseEvalSpec {
  type: 'smoke';
  /** Named check; the handler dispatches on this. */
  check: 'fts5-index-nonempty' | 'no-failed-tasks' | 'audit-chain-intact';
}

/**
 * Compilation-quality handler — scores a compiled wiki page against a
 * rubric using Claude. Handler lives in `@ico/compiler` because it
 * requires the Claude client; this spec type is declared here so the
 * kernel loader can parse + validate the YAML at the same trust
 * boundary as every other eval. The runner dispatches `compilation`
 * specs through compiler-side glue (see `runCompilerEval`).
 */
export interface CompilationEvalSpec extends BaseEvalSpec {
  type: 'compilation';
  /**
   * Which compiler pass output this spec scores. Used only as a label
   * in reports + trace payloads.
   */
  pass: 'summarize' | 'extract' | 'synthesize' | 'link' | 'contradict' | 'gap';
  /** Wiki-relative path to the compiled page being scored. */
  target_page: string;
  /**
   * 1–N rubric criteria the model scores 1–5. The final 0–1 score is
   * the average of all criterion scores, normalized to [0, 1].
   */
  criteria: Array<{
    id: string;
    /** Operator-facing prompt describing what to look for. */
    description: string;
  }>;
  /** Optional model override (defaults to ICO_MODEL or claude-sonnet-4-6). */
  model?: string;
}

/**
 * Citation-fidelity handler (B03) — scans a markdown artifact for inline
 * `[source: <title>]` and `[[slug]]` citation markers, validates each
 * against the workspace `wiki/` index, and scores
 * `verified / total`. Catches hallucinated citations (the canonical
 * LLM failure mode in grounded knowledge systems).
 */
export interface CitationEvalSpec extends BaseEvalSpec {
  type: 'citation';
  /** Workspace-relative path to the markdown artifact being audited. */
  target_file: string;
  /**
   * When true, an artifact with zero citations fails (score 0). Default
   * false — zero citations is vacuously verified.
   */
  require_citations?: boolean;
  /**
   * Wiki-relative paths that the artifact MUST cite. When set and any
   * path is absent from the artifact's resolved citations, the eval
   * fails regardless of the no-hallucination score.
   */
  expected_citations?: string[];
}

/** Union of every supported spec shape. */
export type EvalSpec = RetrievalEvalSpec | SmokeEvalSpec | CompilationEvalSpec | CitationEvalSpec;

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/** Result of a single eval run. */
export interface EvalResult {
  spec: EvalSpec;
  passed: boolean;
  /** Score in `[0, 1]`. `1.0` on a pure pass/fail handler when passed. */
  score: number;
  /** Threshold used for pass/fail. */
  threshold: number;
  /** Human-readable summary surfaced in reports and the eval.result trace. */
  details: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/** Aggregate result over a batch run. */
export interface EvalBatchResult {
  total: number;
  passed: number;
  failed: number;
  /** Per-spec results in the order they ran. */
  results: EvalResult[];
  /** Sum of per-result durations. */
  durationMs: number;
}
