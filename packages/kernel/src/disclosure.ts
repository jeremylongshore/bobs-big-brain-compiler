/**
 * disclosure.ts — the ingest-time no-comp/no-PII guard for the governed brain.
 *
 * The brain is append-only and must NEVER hold compensation, comp-splits, anyone's
 * pay, or PII. This guard is the ICO **source-side** choke: `ico ingest` copies a
 * source into the workspace and registers it in SQLite *before* it is ever spooled
 * to INTKB, so a poisoned source must be rejected here, at ingest, not downstream.
 *
 * It mirrors the same rule enforced at the company's two other choke points so all
 * three agree on what counts as a leak:
 *   • `intent-os/ci/disclosure-gate.sh`                              (CI / commit gate)
 *   • `qmd-team-intent-kb/packages/common/src/disclosure-filter.ts`  (INTKB intake)
 *
 * Blocking semantics deliberately match `disclosure-gate.sh`: only **unambiguous**
 * compensation/PII patterns hard-fail. A bare word like "compensation" appears
 * legitimately in governance docs that NAME the category in order to forbid it
 * (e.g. the disclosure-tier rule itself), so bare category words are NOT rejected —
 * that is the gate's hard-fail-vs-advisory split, reproduced here.
 *
 * @module disclosure
 */

/** Which class of forbidden content tripped the guard. */
export type DisclosureCategory = 'comp' | 'pii';

/** A single disclosure hit: the category and the exact substring that matched. */
export interface DisclosureViolation {
  category: DisclosureCategory;
  /** The matched substring, surfaced in the rejection message. */
  match: string;
}

/**
 * Unambiguous compensation / revenue-split / equity / pay terms. Hard-fail.
 *
 * Ported from the `disclosure-gate.sh` hard-fail set and aligned with INTKB's
 * `COMPENSATION_TERMS_PATTERN`. Bare contextual words ("compensation", "payout",
 * "revenue-share" without a number) are intentionally absent — see module docs.
 */
const COMP_PATTERN =
  /\b\d{1,3}\/\d{1,3}\s*(?:split|share)\b|\b7[- ]bucket\b|revenue[- ]share\s*\d|equity\s+(?:stakes?|grants?|granted|options?|\d)|\bvesting\b|\bRSUs?\b|stock options?\b|\bstrike price\b|\bsalary\b|base pay\b|take[- ]home pay\b|(?:launch|signing|sign[- ]on)\s+bonus\b/i;

/**
 * PII: SSN, background-check outcomes, date of birth. Hard-fail.
 *
 * Ported from the `disclosure-gate.sh` PII set and INTKB's `PII_PATTERN`.
 */
const PII_PATTERN =
  /\b\d{3}-\d{2}-\d{4}\b|\bSSN\b|social security (?:number|no)\b|background[- ]check (?:result|report|passed|failed)\b|date of birth\b|\bDOB\b\s*[:=]/i;

/**
 * Scan a block of text for compensation/comp-split or PII content.
 *
 * Input is NFKC-normalized first so trivial unicode obfuscation (fullwidth digits,
 * compatibility forms) cannot slip a pattern past. Deeper homoglyph/zero-width
 * defenses live at the INTKB team-intake boundary; ICO ingest is single-user
 * (your own files on your own machine), so NFKC is the proportionate normalization.
 *
 * @param text - The content to scan (e.g. a raw source file read as UTF-8).
 * @returns The first {@link DisclosureViolation} found, or `null` when clean.
 */
export function scanForDisclosure(text: string): DisclosureViolation | null {
  const normalized = text.normalize('NFKC');

  const comp = COMP_PATTERN.exec(normalized);
  if (comp !== null) {
    return { category: 'comp', match: comp[0].trim() };
  }

  const pii = PII_PATTERN.exec(normalized);
  if (pii !== null) {
    return { category: 'pii', match: pii[0].trim() };
  }

  return null;
}

/**
 * Human-readable label for a disclosure category, for rejection messages.
 */
export function disclosureLabel(category: DisclosureCategory): string {
  return category === 'pii' ? 'PII' : 'compensation/comp-split';
}
