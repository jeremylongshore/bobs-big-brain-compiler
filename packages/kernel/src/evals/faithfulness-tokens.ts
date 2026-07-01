/**
 * Faithfulness token-meter recorder (e06.8).
 *
 * This is the ONE durable write the compile-faithfulness eval is permitted.
 * The LLM-as-judge produces a groundedness SCORE and a report — neither is
 * written back into the semantic knowledge tables (that would let the model
 * write durable knowledge state, which 003-AT-ARCH forbids). What the kernel
 * DOES record is the judge's TOKEN COST, into a sibling column on the page's
 * compilation row (`compilations.faithfulness_tokens_used`, migration 004).
 *
 * Recording the cost — not the score — keeps the boundary clean: the recorded
 * fact is a meter reading, deterministic and non-semantic, and the compile-side
 * `tokens_used` column stays untouched so the two costs are visible side by
 * side (the "cost parity with the compile itself" the bead requires). This is
 * accounting, not knowledge; the kernel owns it.
 *
 * @module evals/faithfulness-tokens
 */

import type { Database } from 'better-sqlite3';

import { err, ok, type Result } from '@ico/types';

/**
 * Record the judge's token cost for a scored page onto its compilation row.
 *
 * Additive: if the same page is scored again (e.g. a re-run), the new cost is
 * ADDED to the existing meter rather than overwriting it, so the column always
 * reflects the cumulative judge spend attributable to that page. A NULL prior
 * value (never evaluated) is treated as 0.
 *
 * @param db            - Open better-sqlite3 database.
 * @param compilationId - `compilations.id` of the scored page.
 * @param judgeTokens   - Total judge tokens (input + output) for this scoring.
 * @returns `ok()` on success, `err()` if the row is missing or the UPDATE fails.
 */
export function recordFaithfulnessTokens(
  db: Database,
  compilationId: string,
  judgeTokens: number,
): Result<void, Error> {
  if (!Number.isFinite(judgeTokens) || judgeTokens < 0) {
    return err(new Error(`judgeTokens must be a non-negative finite number, got ${judgeTokens}`));
  }
  try {
    const info = db
      .prepare<[number, string], void>(
        `UPDATE compilations
            SET faithfulness_tokens_used = COALESCE(faithfulness_tokens_used, 0) + ?
          WHERE id = ?`,
      )
      .run(Math.round(judgeTokens), compilationId);
    if (info.changes === 0) {
      return err(
        new Error(`No compilation row for id '${compilationId}' — token meter not recorded`),
      );
    }
    return ok(undefined);
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
