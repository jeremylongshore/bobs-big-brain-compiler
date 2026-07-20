/**
 * Type declarations for eval-distiller-output.mjs (the plain-JS distiller
 * groundedness harness). Lets the type-aware ESLint/tsc pass see real types at
 * the `.mjs` import site instead of `any`, so the integration test's calls are
 * not flagged as unsafe. Keep in sync with the module's exported functions.
 */

/** One disclosed per-candidate finding. */
export interface DistillerFinding {
  title: string;
  citation: string;
  check: 'ok' | 'malformed-citation' | 'missing-source' | 'low-overlap';
  overlap: number;
  score: 0 | 1;
}

/** The registrar-shaped verdict for one night's record. */
export interface DistillerVerdict {
  skipped: boolean;
  reason?: string;
  passed: boolean;
  score: number;
  details: {
    date: string | null;
    promoted: number;
    findings: DistillerFinding[];
  };
}

export interface EvaluateOptions {
  minOverlap?: number;
  minScore?: number;
}

export function contentWords(text: string): string[];
export function overlapRatio(title: string, sourceText: string): number;
export function citationToRelPath(citation: unknown): string | null;
export function scoreCandidate(
  candidate: { title?: unknown; citation?: unknown; disposition?: unknown },
  kbExportDir: string,
  minOverlap: number,
): DistillerFinding;
export function evaluateRecord(
  record: unknown,
  kbExportDir: string,
  options?: EvaluateOptions,
): DistillerVerdict;
